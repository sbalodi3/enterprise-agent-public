import { setTimeout as delay } from 'node:timers/promises'
import { DomainError } from '../domain/index.mjs'
import { isClaimConversationId } from '../desktop-chat/claim-routes.mjs'
import * as routing from './scope-router.mjs'
import { actionIntent, explicitActionFields, followups } from './action-intent.mjs'
import { createClaimReads } from './chat-mcp.mjs'
import { selectedDocumentIds } from '../domain/chat.mjs'
import { candidateScope, continuation } from '../domain/turn-questions.mjs'
import { inboxSource } from '../ui/outlook-chat.mjs'
import { renderDocumentPdf } from '../showcase/data/pdf.mjs'

const fail = (status, code) => { throw new DomainError(status, code) }

// Only the browser that submitted the turn supplies its authorization. Moving to another
// page closes that page's stream but does not revoke a still-live login or restart the turn.
export function createConversationApi({ domain, auth, runTurn, trace, shutdown, runOutlook, outlookConnected, planTurn = routing.planClaimRequest }) {
  async function submit(req, ctx, conversationId, input, reply = false) {
    const peer = auth.admit(req).peer
    if (!peer) fail(401, 'AUTH_REQUIRED')
    const started = reply ? await domain.replyChatTurn(ctx, conversationId, input) : await domain.startChatTurn(ctx, conversationId, input)
    const { turnId, attemptId, conversation } = started
    if (started.started) {
      const signal = AbortSignal.any([peer.signal, shutdown, AbortSignal.timeout(155000)].filter(Boolean))
      let scope = started.scope ?? conversation.scope
      let baseline = started.dependencies || []
      let history = started.modelHistory
      const activity = new Map()
      const checkSession = () => {
        signal.throwIfAborted()
        auth.require(req)
      }
      const guardedDescription = describe => describe && (async (...args) => {
        checkSession()
        const result = await describe(...args)
        checkSession()
        return result
      })
      async function reauthorize(dependencies = []) {
        if (signal.aborted) fail(409, 'turn_interrupted')
        auth.require(req)
        await domain.assertChatScope(ctx, scope, [...baseline, ...dependencies])
        signal.throwIfAborted()
        auth.require(req)
      }
      const perform = async () => {
        checkSession()
        const question = started.question ?? input.question
        let plan = started.plan
        const choices = continuation(started.replies ?? [], started.exclusions)
        if (started.planned) {
          if (choices.chooseCandidate) {
            const candidate = choices.chooseCandidate
            await domain.assertChatScope(ctx, candidateScope(candidate), [candidate])
          }
          // A model-posed clarification resumes the same verified operation; routing
          // questions can change the chosen record or source and must resolve again.
          const resolved = choices.resumeModel && plan ? { scope, operation: plan } : await planTurn({
            domain, ctx, trace, question, pins: conversation.scope, focus: conversation.focus, previous: started.previousPlan,
            ...choices, signal, describeTarget: guardedDescription(runTurn.describeTarget),
            describePortfolio: guardedDescription(runTurn.describePortfolio),
            outlookConnected: inboxSource(question) === 'ambiguous' && outlookConnected ? await outlookConnected(ctx) : false,
          })
          signal.throwIfAborted()
          auth.require(req)
          if (resolved.question) {
            await domain.pauseChatTurn(ctx, conversationId, turnId, attemptId, resolved.question, 'planner')
            return
          }
          if (!resolved.scope || resolved.workspace) fail(400, 'workspace_question')
          scope = resolved.scope
          plan = resolved.operation
          const bound = await domain.bindTurnPlan(ctx, conversationId, turnId, attemptId, scope, plan, resolved.focus, resolved.dependencies)
          baseline = bound.dependencies
          history = bound.modelHistory
        }
        const onActivity = async (entry, dependencies = []) => {
          await reauthorize(dependencies)
          activity.set(entry.id, entry)
          await domain.setChatActivity(ctx, conversationId, turnId, attemptId, [...activity.values()], [...baseline, ...dependencies])
        }
        await reauthorize()
        let result
        const intent=actionIntent(question)
        const oneClaim=scope.kind==='claim' && scope.claimIds.length===1 && !selectedDocumentIds(scope,scope.claimIds[0])
        if (domain.availableActions && intent && oneClaim && /^(CLM-\d{6}|WC-102)$/.test(scope.claimIds[0]) && plan?.kind!=='outlook') {
          const claimId=scope.claimIds[0]
          const view=await domain.availableActions(ctx,claimId)
          const reads=createClaimReads({domain,principal:ctx,scope,requestedAction:intent,
            allowed:['list_claim_actions','check_action_status','read_juris_record','prepare_claim_action'],reauthorize,onActivity,signal,trace})
          const fields=explicitActionFields(intent,question,view.finalized)
          const canPrepare=view.actions.includes(intent)
          const tool=intent==='record'?'read_juris_record':intent==='status'?'check_action_status':canPrepare && fields?'prepare_claim_action':'list_claim_actions'
          const {structuredContent:data}=await reads.call(tool,tool==='prepare_claim_action'?{action:intent,...fields}:{})
          result={text:tool==='prepare_claim_action' || ['status','list','record'].includes(intent)?data.text:
            canPrepare?'Review the details for '+claimId+' below.':'This action is unavailable for '+claimId+'.',
            sources:[],dependencies:[{claimId,claimVersion:view.version}],
            actionContext:{claimId,proposalId:data.proposalId,...(canPrepare && !fields && {autoEdit:intent})}}
          if (canPrepare && !fields) {
            try {
              const assisted=await runTurn({principal:ctx,scope,plan,pinnedScope:conversation.scope,question,history,signal,reauthorize,onActivity,
                planned:started.planned===true,clarifications:choices.modelClarifications,answers:choices.modelClarifications})
              if (assisted.actionContext?.proposalId || assisted.pendingQuestion) result=assisted
            } catch(error) {
              if (!['local_model_unavailable','unverified_source_response','invalid_action_fields','chat_verifier_unavailable'].includes(error.code)) throw error
            }
          }
        } else if (plan?.kind === 'outlook') {
          if (!runOutlook) fail(409, 'outlook_not_connected')
          result = await runOutlook({ principal: ctx, conversationId, turnId, question, timeZone: started.timeZone, signal, reauthorize })
        } else if (plan?.kind === 'workbench') result = await domain.workQuery(ctx, plan)
        else result = await runTurn({
          principal: ctx, scope, plan, pinnedScope: conversation.scope, question, history, signal, reauthorize, onActivity,
          planned: started.planned === true, portfolioQuery: plan?.kind === 'portfolio' ? plan : undefined,
          clarifications: choices.modelClarifications, answers: choices.modelClarifications,
        })
        const pending = result.pendingQuestion ?? result.question
        if (pending && started.planned) {
          await reauthorize(result.dependencies)
          await domain.pauseChatTurn(ctx, conversationId, turnId, attemptId, pending, 'model', result.dependencies)
          return
        }
        const { dependencies = [], ...answer } = result
        if (domain.availableActions && plan?.kind!=='outlook' && scope.kind==='claim' && scope.claimIds.length===1 &&
          !selectedDocumentIds(scope,scope.claimIds[0]) && /^(CLM-\d{6}|WC-102)$/.test(scope.claimIds[0])) {
          let view
          try { view=await domain.availableActions(ctx,scope.claimIds[0]) }
          catch (error) {
            // A source outage can suppress suggestions while a grounded Workbench answer is still usable.
            if (error.code!=='juris_unavailable' && error.code!=='invalid_juris_record') throw error
          }
          if (view) {
            const suggestions=followups(question+' '+(answer.text||''),view)
            answer.actionContext={...answer.actionContext,claimId:view.claimId,suggestions,
              ...(answer.sources?.length && {source:answer.sources[0],note:answer.text?.slice(0,1800)})}
            if (intent==='status') answer.actionContext={...answer.actionContext,showStatus:true,suggestions:[]}
          }
        }
        await reauthorize(dependencies)
        await domain.finishChatTurn(ctx, conversationId, turnId, attemptId, {
          answer, activity: [...activity.values()], dependencies: [...baseline, ...dependencies],
        })
      }
      void trace.run('chat.turn', perform, ctx).catch(error => {
        const code = error instanceof DomainError ? error.code : 'chat_service_unavailable'
        if (!(error instanceof DomainError)) {
          // Keep the failing code location for local diagnosis. Provider text,
          // tool arguments, workspace paths and employee IDs never enter this log.
          const location = /\/(claim-chat|chat-mcp|conversation-api)\.mjs:(\d+):\d+/.exec(error?.stack || '')
          console.warn('Claims conversation service failed', location ? location[1] + ':' + location[2] : 'unknown location')
        }
        return domain.failChatTurn(ctx, conversationId, turnId, attemptId, code)
      }).catch(() => console.error('Claims conversation could not record the turn outcome'))
    }
    return { conversationId, turnId }
  }

  async function stream(req, res, ctx, id) {
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    const session = auth.admit(req).peer
    if (!session) fail(401, 'AUTH_REQUIRED')
    const signal = AbortSignal.any([controller.signal, session.signal, shutdown])
    let previous
    try {
      while (!signal.aborted) {
        auth.require(req)
        const snapshot = await domain.conversation(ctx, id)
        if (signal.aborted) break
        auth.require(req)
        const json = JSON.stringify(snapshot)
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
          res.flushHeaders()
        }
        if (json !== previous) res.write('event: conversation\ndata: ' + json + '\n\n')
        previous = json
        if (!snapshot.turns.some(turn => turn.state === 'running')) break
        await delay(500, undefined, { signal })
      }
    } catch (error) {
      if (!res.headersSent && !signal.aborted) throw error
      if (!res.destroyed && !res.writableEnded) res.write('event: unavailable\ndata: {}\n\n')
    } finally {
      if (res.headersSent && !res.writableEnded) res.end()
    }
  }

  async function source(req, ctx, id, query, res) {
    const ref = {
      claimId: query.get('claimId'), claimVersion: Number(query.get('claimVersion')),
      documentId: query.get('documentId'), documentVersion: Number(query.get('documentVersion')),
      anchorId: query.get('anchorId'),
    }
    const format = query.get('format')
    if (format && format !== 'pdf') fail(400, 'invalid_format')
    const doc = await domain.citedChatSource(ctx, id, ref)
    auth.require(req)
    if (format !== 'pdf') return doc
    const bytes = renderDocumentPdf(doc)
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length,
      'content-disposition': 'inline; filename="' + encodeURIComponent(doc.id) + '.pdf"',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(bytes)
  }

  return async function conversationApi(req, res, ctx, path, input, query) {
    if (req.method === 'GET' && path === 'bootstrap') return { enabled: !!runTurn, plannedTurns: true, subject: ctx.subject, csrfToken: auth.browserCsrf(req) }
    if (!runTurn) fail(404, 'not_found')
    if (req.method === 'POST' && path === 'route') return routing.routeClaimsPrompt({ domain, ctx, input, trace })
    if (path === 'conversations') {
      if (req.method === 'GET') return domain.chatConversations(ctx)
      if (req.method === 'POST') return domain.openConversation(ctx, input.scope, { fresh: input.fresh })
    }
    if (path === 'search' && req.method === 'GET') {
      const lines = query.getAll('lob')
      const flags = {}
      for (const key of ['assignedOnly','dueToday','waitingOnly']) {
        if (!query.has(key)) continue
        if (!['true','false'].includes(query.get(key))) fail(400, 'invalid_claim_search')
        flags[key] = query.get(key) === 'true'
      }
      const { items, total, asOf } = await domain.chatSearch(ctx, { query: query.get('q') || '',
        status: query.get('status') ?? 'open', ...flags,
        ...(lines.length === 1 ? { lob: lines[0] } : lines.length > 1 ? { lobs: lines } : {}),
        ...Object.fromEntries(['sourceStatus','ownerId'].filter(k => query.has(k)).map(k => [k, query.get(k)])),
        offset: Number(query.get('offset') ?? 0), limit: Number(query.get('limit') ?? 30) })
      return { items, total, asOf }
    }
    const [operation, id, extra] = path.split('/')
    if (operation === 'documents' && id && extra === undefined && req.method === 'GET') return domain.chatDocuments(ctx, id)
    if (!isClaimConversationId(id) || extra !== undefined) fail(404, 'not_found')
    if (operation === 'scope' && req.method === 'POST') return domain.updateChatScope(ctx, id, input.scope, input.expectedRevision, ...(input.resetFocus === true ? [true] : []))
    // The existing turn path is also usable through a previously launched desktop bridge.
    if (operation === 'turn' && req.method === 'POST') return submit(req, ctx, id, input, input.kind === 'reply')
    if (operation === 'reply' && req.method === 'POST') return submit(req, ctx, id, input, true)
    if (req.method === 'GET') {
      if (operation === 'conversation') return domain.conversation(ctx, id)
      if (operation === 'events') return stream(req, res, ctx, id)
      if (operation === 'source') return source(req, ctx, id, query, res)
    }
    fail(404, 'not_found')
  }
}
