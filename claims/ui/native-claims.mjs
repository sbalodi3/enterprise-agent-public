import { createClaimChat, request, replyToQuestion } from './claim-chat.mjs'
import { createScopePicker, currentScopeLabel, selectionScope, selections } from './claim-scope.mjs'
import { createOutlookChat } from './outlook-chat.mjs'

const workspace = Object.freeze({ kind: 'workspace' })
const key = 'enterprise.claim-chat.binding.'
const outstanding = record => record?.turns?.some(t => t.state === 'running' || t.state === 'awaiting_input')
const sameScope = (a, b) => a?.kind === b?.kind && JSON.stringify(selectionScope(selections(a))) === JSON.stringify(selectionScope(selections(b)))
function saved(id) { try { return sessionStorage.getItem(key + id) } catch { return null } }
function save(id, value) { try { sessionStorage.setItem(key + id, value) } catch { /* Usable in memory. */ } }

export function existingClaimsSession(conversation, ids) {
  if (!conversation) return undefined
  let archived = new Set()
  try { archived = new Set((JSON.parse(sessionStorage.getItem(key + 'choices.' + conversation) || '{}').segments || []).map(part => part.workspace)) } catch {}
  return ids.find(id => !archived.has(id) && saved(id) === conversation)
}

/** The native session stores ordinary workspace turns. Its protected companion stores verified claim turns. */
export function createNativeClaims(React, ctx, csrf, onOpenCase) {
  const h = React.createElement
  const Picker = createScopePicker(React)
  const { Turn, SourcePanel } = createClaimChat(React)
  const states = new Map()
  const mail = createOutlookChat(React, csrf, supersedeProtectedTurn)
  function state(id) {
    if (!states.has(id)) states.set(id, { value: { scope: workspace }, subscribers: new Set(), id: saved(id),
      superseded: saved('superseded.' + id),
      excludedClaims: new Set(), excludedDocs: new Set(), documents: new Map(), version: 0 })
    return states.get(id)
  }
  // Workspace and native mailbox turns live in separate stores. Anchor the break
  // to one protected turn so a newer drawer or native claim result can be used.
  function supersedeProtectedTurn(id) {
    const s = state(id), latest = s.value.record?.turns.at(-1)
    if (!latest) return
    s.superseded = latest.id
    save('superseded.' + id, latest.id)
  }
  function set(s, update) {
    s.value = { ...s.value, ...update }
    for (const f of s.subscribers) f()
  }
  function storeChoices(s) {
    if (!s.id || !s.value.record) return
    try { sessionStorage.setItem(key + 'choices.' + s.id, JSON.stringify({
      claims: [...s.excludedClaims], documents: [...s.excludedDocs], segments: s.segments || [],
    })) } catch { /* Memory-only in private contexts. */ }
  }
  function snapshot(s, record) {
    if (!s.value.hydrated && record.id === s.id) {
      try {
        const choices = JSON.parse(sessionStorage.getItem(key + 'choices.' + s.id) || '{}')
        s.excludedClaims = new Set(choices.claims || []); s.excludedDocs = new Set(choices.documents || [])
        s.segments = Array.isArray(choices.segments) ? choices.segments : []
      } catch { s.segments = [] }
    }
    ++s.version
    set(s, { record, scope: record.scope, error: '', denied: false, hydrated: true })
  }
  function problem(s, e) {
    const denied = [401,403,404].includes(e.status)
    set(s, { error: e.message || 'Could not reach the claims service. Try again.',
      ...(denied ? { record: null, scope: workspace, denied: true, undo: null } : {}) })
  }
  async function refresh(s, signal) {
    const ticket = ++s.version
    if (!s.id) return
    try {
      const record = await request('conversation/' + encodeURIComponent(s.id), { signal })
      if (!signal?.aborted && ticket === s.version) snapshot(s, record)
    } catch (e) { if (!signal?.aborted && ticket === s.version) problem(s, e); throw e }
  }
  async function open(id, s, scope) {
    const record = await request('conversations', { csrf, body: { scope, fresh: true } })
    s.id = record.id
    save(id, record.id)
    snapshot(s, record)
    return record
  }
  async function apply(id, scope, known = new Map(), manual = true) {
    const s = state(id)
    if (s.mutating) throw Error('Wait for the current change to finish.')
    s.mutating = true
    try {
      if (s.id && !s.value.record) await refresh(s)
      const old = s.value.scope
      const rotate = manual && (old.kind !== 'workspace' || s.value.record?.focus?.claimIds?.length) && scope.kind === 'workspace' && s.id &&
        (s.value.record?.turns.length || ctx.sessions.list.getSnapshot().byId[id]?.blank === false)
      let nextId
      if (rotate) {
        const owning = ctx.workspaces.list.getSnapshot().items.find(w => w.sessionIds.includes(id))
        if (!owning) throw Error('Reopen your workspace to continue.')
        nextId = await ctx.sessions.create({ workspaceId: owning.workspaceId })
      }
      if (!sameScope(old, scope) || s.value.record?.focus?.claimIds?.length && !sameScope(s.value.record.focus, scope)) {
        if (!s.id) await open(id, s, scope)
        else {
          const record = await request('scope/' + encodeURIComponent(s.id), { csrf,
            body: { scope, resetFocus: true, expectedRevision: s.value.record.scopeRevision } })
          snapshot(s, record)
        }
      }
      if (manual) {
        mail.clearSelection(id)
        for (const [claim, docs] of known) s.documents.set(claim, docs)
        const prior = selections(old), next = selections(scope)
        for (const claim of prior.keys()) if (!next.has(claim)) s.excludedClaims.add(claim)
        for (const [claim, selected] of next) {
          s.excludedClaims.delete(claim)
          for (const doc of s.documents.get(claim) || []) {
            if (selected === null || selected.has(doc.id)) s.excludedDocs.delete(doc.id)
            else s.excludedDocs.add(doc.id)
          }
        }
        set(s, { undo: null, notice: '' })
        if (nextId) {
          const archived = new Set((s.segments || []).flatMap(part => part.turnIds))
          s.segments = [...(s.segments || []), { workspace: id, turnIds: s.value.record.turns.filter(t => !archived.has(t.id)).map(t => t.id) }]
          save(nextId, s.id)
          states.set(nextId, s)
          ctx.uiWorkspace.openSession(nextId)
        }
        storeChoices(s)
      }
    } catch (e) {
      if (e.status === 409) await refresh(s).catch(() => {})
      problem(s, e); throw e
    } finally { s.mutating = false }
  }
  async function submit(id, question, requestId, signal) {
    const s = state(id)
    if (outstanding(s.value.record)) throw Error('Finish or cancel the current question first.')
    // Reuse the request ID when the network drops after the service has admitted the turn.
    const revision = s.value.record.scopeRevision
    const attempt = s.attempt?.question === question && s.attempt.revision === revision ? s.attempt :
      { question, revision, requestId: requestId || crypto.randomUUID(),
        excludedPreviousTurnId: s.superseded === s.value.record.turns.at(-1)?.id ? s.superseded : undefined }
    s.attempt = attempt
    await request('turn/' + encodeURIComponent(s.id), { csrf, signal,
      body: { question, requestId: attempt.requestId, expectedRevision: revision, expectedFocus: s.value.record.focus || null, planned: true,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, excludedClaimIds: [...s.excludedClaims],
        excludedDocumentIds: [...s.excludedDocs], excludedPreviousTurnId: attempt.excludedPreviousTurnId || undefined } })
    s.attempt = null
    set(s, { awaiting: true })
    // Once admitted, a failed refresh must never restore the draft and send a duplicate.
    await refresh(s, signal).catch(() => {})
  }
  async function dispatch(id, text, attachmentCount, signal) {
    const s = state(id)
    if (s.busy || s.mutating) return 'hold'
    s.busy = true
    try {
      if (s.id && !s.value.record) await refresh(s, signal)
      if (!text.trim() && !s.id && attachmentCount) return 'workspace'
      if (outstanding(s.value.record)) {
        set(s, { notice: 'Finish or cancel the current question first.' })
        return 'hold'
      }
      const latest = s.value.record?.turns.at(-1)
      const protectedLast = latest && latest.id !== s.superseded
      const previous = protectedLast && latest.state === 'completed' ? latest.answer?.portfolioQuery ?? latest.plan : undefined
      // An Outlook result originating in the protected conversation has its own mailbox result references.
      if (previous?.kind !== 'outlook' || mail.state(id).mailSelected) {
        const mailDispatch = await mail.dispatch(id, text, attachmentCount, signal, undefined, !protectedLast)
        if (mailDispatch) return mailDispatch
      }
      const scope = s.value.record?.focus ?? s.value.scope
      const routed = await request('route', { csrf, signal, body: { preflight: true, question: text, scope, previous } })
      if (routed.action === 'workspace') {
        supersedeProtectedTurn(id)
        mail.clearSelection(id)
        set(s, { notice: '' })
        return 'workspace'
      }
      if (routed.action !== 'claims' || attachmentCount) {
        set(s, { notice: attachmentCount || routed.mixed
          ? 'Send workspace and claims questions separately. Attach claim documents with Choose scope.'
          : 'Specify whether to use your workspace or your claim records.' })
        return 'hold'
      }
      if (!s.id) await open(id, s, workspace)
      set(s, { notice: '' })
      await submit(id, text, undefined, signal)
      return 'handled'
    } catch (e) {
      if (!signal?.aborted) { if (e.status === 409) await refresh(s, signal).catch(() => {}); problem(s, e) }
      return 'hold'
    } finally { s.busy = false }
  }
  function useStateFor(id) {
    const s = state(id)
    const subscribe = React.useCallback(f => { s.subscribers.add(f); return () => s.subscribers.delete(f) }, [s])
    return [s, React.useSyncExternalStore(subscribe, () => s.value)]
  }
  function Controls({ sessionId: id }) {
    const [s, v] = useStateFor(id)
    return h(React.Fragment, null,
      h('button', { type: 'button', className: 'cs-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': !!v.picker,
        disabled: outstanding(v.record), onClick: () => { mail.clearSelection(id); set(s, { picker: true }) } }, 'Choose scope'),
      h(mail.Control, { id }),
      v.picker && h(Picker, { scope: v.scope, apply: (scope, known) => apply(id, scope, known), close: () => set(s, { picker: false }) }))
  }
  function Chips({ sessionId: id }) {
    const [s, v] = useStateFor(id), entries = selections(v.scope)
    if (mail.useSnapshot(id).mailSelected) return null
    const remove = claim => {
      entries.delete(claim)
      void apply(id, selectionScope(entries)).catch(() => {})
    }
    const focus = v.record?.focus
    const inferred = focus?.claimIds?.length && !sameScope(focus, v.scope) ? focus : null
    if (!inferred && !entries.size && !v.error && !v.notice && v.scope.kind !== 'portfolio') return null
    return h('div', { className: 'cs-chips', 'aria-label': 'Selected scope' },
      [...entries].map(([claim, docs]) => h('span', { className: 'cs-chip', key: claim },
        h('button', { type: 'button', disabled: outstanding(v.record), onClick: () => set(s, { picker: true }) }, claim,
          h('small', null, docs === null ? 'Pinned · All documents' : 'Pinned · ' + docs.size + (docs.size === 1 ? ' document' : ' documents'))),
        h('button', { type: 'button', 'aria-label': 'Remove ' + claim, disabled: outstanding(v.record), onClick: () => remove(claim) }, '×'))),
      v.scope.kind === 'portfolio' && h('span', { className: 'cs-chip' }, 'My portfolio',
        h('button', { type: 'button', 'aria-label': 'Clear portfolio scope', onClick: () => void apply(id, workspace).catch(() => {}) }, '×')),
      inferred && h('span', { className: 'cs-chip' }, currentScopeLabel(inferred),
        h('button', { type: 'button', 'aria-label': (inferred.claimIds.some(id => entries.has(id)) ? 'Clear current scope for ' : 'Remove ') + inferred.claimIds.join(', '), disabled: outstanding(v.record),
          onClick: () => {
            void apply(id, v.scope).then(() => {
              for (const [claim, docs] of selections(inferred)) {
                if (docs) { for (const doc of docs) s.excludedDocs.add(doc) }
                else if (!entries.has(claim)) s.excludedClaims.add(claim)
              }
              storeChoices(s)
            }).catch(() => {})
          } }, '×')),
      v.notice && h('span', { className: 'cs-notice', role: 'status' }, v.notice),
      v.error && h('span', { className: 'cs-notice', role: 'alert' }, v.error,
        s.id && h('button', { type: 'button', onClick: () => void refresh(s).catch(() => {}) }, 'Retry')))
  }
  // Previous native segments stay in their originating workspace log. Read only the
  // employee's messages and visible assistant text when presenting a closed segment.
  function WorkspaceHistory({ id }) {
    const [rows, setRows] = React.useState([])
    const [failed, setFailed] = React.useState(false)
    React.useEffect(() => {
      let active = true, off
      const ref = ctx.sessions.retain(id, { source: 'controllerOperation' })
      ref.ready.then(binding => {
        if (!active) return
        const read = () => {
          const entries = binding.eventSource.getSnapshot().entries
          const visible = []
          for (const { event } of entries) {
            const user = event.type === 'user/message' && event.data.source?.kind === 'user'
            if (!user && event.type !== 'assistant/message') continue
            const text = event.data.content?.filter(block => block.type === 'text').map(block => block.text).join('\n')
            if (text) visible.push({ key: event.seq, user, text })
          }
          setRows(visible)
        }
        off = binding.eventSource.subscribe(read); read()
      }).catch(() => { if (active) setFailed(true) })
      return () => { active = false; off?.(); ref.release() }
    }, [id])
    if (failed) return h('p', { role: 'status' }, 'An earlier workspace session is unavailable.')
    return rows.map(row => h('article', { className: 'cc-turn', key: row.key },
      h('div', { className: row.user ? 'cc-user-turn' : 'cc-answer' }, h('p', null, row.text))))
  }
  function History({ sessionId }) { return h(Transcript, { sessionId, archived: true }) }
  function Transcript({ sessionId: id, archived = false }) {
    const [s, v] = useStateFor(id)
    const [preview, setPreview] = React.useState(null)
    const root = React.useRef(null)
    const returnTo = React.useRef(null)
    const conversation = s.id
    React.useEffect(() => {
      if (!conversation || archived) return
      const url = new URL(location.href)
      url.searchParams.set('conversation', conversation)
      url.searchParams.delete('claim')
      if (url.hash !== '#workbench') url.hash = 'claim-chat'
      history.replaceState(history.state, '', url)
      return () => {
        const current = new URL(location.href)
        if (current.searchParams.get('conversation') === conversation && current.hash === '#claim-chat') {
          current.searchParams.delete('conversation'); current.hash = ''; history.replaceState(history.state, '', current)
        }
      }
    }, [conversation])
    React.useEffect(() => {
      if (!conversation || archived) return
      const stop = new AbortController()
      const sync = () => void refresh(s, stop.signal).catch(() => {})
      sync()
      window.addEventListener('focus', sync)
      window.addEventListener('claims:portfolio-refreshed', sync)
      const visible = () => { if (!document.hidden) sync() }
      document.addEventListener('visibilitychange', visible)
      return () => { stop.abort(); window.removeEventListener('claims:portfolio-refreshed', sync); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', visible) }
    }, [s, conversation])
    const running = v.record?.turns?.some(t => t.state === 'running')
    React.useEffect(() => {
      if (archived || !conversation || v.denied || (!running && !v.awaiting)) return
      const stop = new AbortController()
      let timer
      async function poll() {
        try {
          await refresh(s, stop.signal)
          if (!stop.signal.aborted && s.value.record && !s.value.record.turns.some(t => t.state === 'running')) {
            set(s, { awaiting: false }); return
          }
        } catch { /* The next authorized read may recover. */ }
        if (!stop.signal.aborted && !s.value.denied) timer = setTimeout(poll, 1000)
      }
      timer = setTimeout(poll, 300)
      return () => { stop.abort(); clearTimeout(timer) }
    }, [s, conversation, v.awaiting, running, v.denied])
    const all = v.record?.turns || []
    const archivedIds = new Set((s.segments || []).flatMap(part => part.turnIds))
    const turns = all.filter(t => archivedIds.has(t.id) === archived)
    const sources = turns.flatMap(t => t.answer?.sources || [])
    const visiblePreview = preview && sources.some(ref => ref.claimId === preview.selected.claimId && ref.documentId === preview.selected.documentId &&
      ref.anchorId === preview.selected.anchorId && ref.documentVersion === preview.selected.documentVersion && ref.claimVersion === preview.selected.claimVersion)
    React.useEffect(() => { if (preview && !visiblePreview) setPreview(null) }, [visiblePreview, preview])
    const last = turns.at(-1)
    React.useEffect(() => {
      if (last && !preview) root.current?.querySelector('.cc-turn:last-of-type')?.scrollIntoView({ block: 'nearest' })
    }, [last?.id, last?.state])
    const mailTurns = !archived && h(mail.Transcript, { id })
    if (v.denied || !v.record || (!turns.length && (!archived || !s.segments?.length))) return mailTurns || null
    function choose(scope, question) {
      void apply(id, scope).then(() => {
        if (question) ctx.conversation.input.for(ctx.sessions.binding(id).ctx).setDraft(question)
      }).catch(e => problem(s, e))
      setPreview(null)
    }
    async function reply(turn, response) {
      try {
        await replyToQuestion(conversation, csrf, v.record.scopeRevision, turn, response)
        set(s, { awaiting: true, notice: '' })
        await refresh(s)
      } catch (error) {
        if (error.status === 409) await refresh(s)
        throw error
      }
    }
    const showTurn = t => h(Turn, { csrf,key: t.id, turn: t, conversationId: conversation, reply: archived ? undefined : reply, scope: t.scope || v.scope, choose, onOpenCase,
        onSource(selected, refs, control) { returnTo.current = control; setPreview({ selected, sources: refs }) },
        retry: (q, rid) => void submit(id, q, rid).catch(e => problem(s, e)) })
    const byId = new Map(turns.map(t => [t.id, t]))
    const body = archived ? (s.segments || []).map(part => h(React.Fragment, { key: part.workspace },
      h(WorkspaceHistory, { id: part.workspace }), part.turnIds.map(tid => byId.has(tid) ? showTurn(byId.get(tid)) : null))) : turns.map(showTurn)
    return h('section', { className: 'cc-root cs-transcript cc-session', 'aria-label': archived ? 'Earlier conversation history' : 'Claims conversation history', ref: root },
      body, mailTurns,
      visiblePreview && h(SourcePanel, { conversation, ...preview, onSelect: selected => setPreview({ ...preview, selected }),
        close() { setPreview(null); requestAnimationFrame(() => returnTo.current?.focus()) }, askDocument: choose }))
  }
  return {
    history: History, transcript: Transcript, chips: Chips, controls: Controls, dispatch,
    existing: existingClaimsSession, // Workstations can update separately from the application gateway.
    observe(id, notify) {
      const s = state(id), offMail = mail.observe(id,notify)
      s.subscribers.add(notify)
      return () => { offMail(); s.subscribers.delete(notify) }
    },
    hasTurns: id => !!(state(id).value.record?.turns.length || mail.state(id).mailTurns?.length),
    hasThread: id => !!state(id).id || mail.occupied(id),
    isScoped: id => { const s = state(id); return !!mail.state(id).mailSelected || !!s.id && (!s.value.hydrated || s.value.denied || s.value.scope.kind !== 'workspace' || !!s.value.record?.focus?.claimIds?.length || outstanding(s.value.record)) },
    async bind(id, target, propagateError = false) {
      const s = state(id)
      try {
        if (target.conversation) { s.id = target.conversation; save(id, s.id); await refresh(s) }
        else if (target.claim) await apply(id, { kind: 'claim', claimIds: [target.claim] })
      } catch (e) { problem(s, e); if (propagateError) throw e }
    },
  }
}
