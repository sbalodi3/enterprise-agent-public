import { randomUUID } from 'node:crypto'
import { createUserMessage, LlmAdapter } from '../../packages/llm/llm/lib/index.js'
import { DomainError } from '../domain/index.mjs'

const textBlocks = (message) =>
  message?.content
    ?.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('') || ''
const tasks = {
  timeline: 'Read the timeline and summarize its most recent changes.',
  compare_evidence: 'Compare the available sources and identify conflicting or missing evidence.',
  explain_priority: 'Explain why the current item has its priority and what the examiner can do next.',
  prepare_handoff: 'Draft a handoff with owner, next action and evidence references.',
}

// The replay exercises the same tool execution, scope checks and session log as live inference.
export class ClaimsReplay extends LlmAdapter {
  async *stream(options) {
    const lastTool = options.messages.findLast((m) => m.role === 'tool')
    if (!lastTool) {
      const request = JSON.parse(
        textBlocks(options.messages.findLast((m) => m.role === 'user' && m.source?.kind === 'user')),
      )
      if (!Object.hasOwn(tasks, request.task)) throw new Error('Unsupported replay task')
      const id = 'claims-replay-1'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: request.task, argumentsDelta: '{}' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: request.task, arguments: '{}' },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = textBlocks(lastTool)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function brief(task, detail, bodies) {
  const { item, timeline, evidence } = detail
  const sources = evidence.map((e) => e.title + ' [' + e.id + ']').join(', ') || item.source
  if (task === 'timeline')
    return (
      timeline.map((e) => e.at + ' — ' + e.summary + ' [' + e.source + ']').join('\n') ||
      item.reason + ' [' + item.source + ']'
    )
  if (task === 'compare_evidence')
    return (
      bodies.map((e) => e.title + ' [' + e.id + ']\n' + e.body).join('\n\n') ||
      'No source documents are available for this item.'
    )
  if (task === 'prepare_handoff')
    return (
      item.id +
      ' · ' +
      item.title +
      '\nAssigned to ' +
      item.ownerId +
      '. ' +
      item.reason +
      '\nNext action: ' +
      item.nextAction +
      '\nSources: ' +
      sources
    )
  return (
    item.reason +
    '\nNext action: ' +
    item.nextAction +
    (item.dueAt ? '\nDue: ' + item.dueAt : '') +
    '\nSource: ' +
    item.source +
    ' · ' +
    item.asOf +
    '\nEvidence: ' +
    sources
  )
}

const comparisonFormat =
  'After calling compare_evidence, return only a JSON object with an excerpts array. Select one short, exact, useful quote from each available source (up to three sources). Each entry has the actual source id and quote. Example structure: {"excerpts":[{"id":"<source id>","quote":"<exact words from the source body>"}]}. An empty source list requires an empty array.'

const priorityFormat =
  'After calling explain_priority, select the recorded facts relevant to the question. Return only JSON with a fields array listing their keys in your preferred order. Always include "reason". Allowed keys are "reason", "nextAction", "dueAt", and "ownerId". The workbench displays exact facts, deadlines and source citations. Example: {"fields":["reason","dueAt","nextAction"]}.'
function parseSelection(output) {
  try {
    return JSON.parse(
      output
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, ''),
    )
  } catch {
    return null
  }
}

export function renderPriority(output, { item, evidence }) {
  const fields = parseSelection(output)?.fields
  const facts = {
    reason: item.reason,
    nextAction: 'Next action: ' + item.nextAction,
    dueAt: item.dueAt ? 'Due: ' + item.dueAt : null,
    ownerId: 'Assigned to ' + item.ownerId,
  }
  if (
    !Array.isArray(fields) ||
    !fields.includes('reason') ||
    fields.length > 4 ||
    fields.some((k) => typeof k !== 'string' || !Object.hasOwn(facts, k)) ||
    new Set(fields).size !== fields.length
  )
    return null
  // Always show the recorded deadline when present, the source name and its original timestamp.
  const order = new Set([...fields, 'nextAction', 'dueAt'])
  const lines = [...order].map((key) => facts[key]).filter(Boolean)
  lines.push('Source: ' + item.source + ' · ' + item.asOf)
  if (evidence.length) lines.push(evidence.map((e) => e.title + ' [' + e.id + ']').join(', '))
  return lines.join('\n')
}

// The model chooses the passages. Publish only verifiable excerpts with their
// source labels; free-form conclusions about evidence it never read are discarded.
export function renderComparison(output, sources) {
  const parsed = parseSelection(output)
  const excerpts = parsed?.excerpts
  if (!Array.isArray(excerpts) || excerpts.length !== Math.min(sources.length, 3)) return null
  if (!sources.length) return 'No source documents are available for comparison.'
  const used = new Set()
  const lines = []
  for (const entry of excerpts) {
    const source = sources.find((e) => e.id === entry?.id)
    const quote = typeof entry?.quote === 'string' ? entry.quote.trim() : ''
    if (!source || used.has(source.id) || !quote || quote.length > 900 || !source.body.includes(quote))
      return null
    used.add(source.id)
    lines.push(source.title + ' [' + source.id + '] — ' + quote)
  }
  if (sources.length === 1) lines.push('Only one source is available for comparison.')
  return lines.join('\n')
}

async function runTurn(agent, message, mode) {
  const seq = agent.session.seq
  agent.followup(
    createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: JSON.stringify(message) }],
    }),
  )
  await agent.whenIdle()
  let text = '',
    reason
  for (let i = seq; i < agent.session.seq; i++) {
    const entry = agent.session.eventAt(i)
    if (entry.type === 'assistant/message' && textBlocks(entry.data.message))
      text = textBlocks(entry.data.message)
    if (entry.type === 'turn/end') reason = entry.data.reason.kind
  }
  if (reason !== 'completed' || !text)
    throw new DomainError(503, mode === 'live' ? 'local_model_unavailable' : 'replay_incomplete')
  return text
}

export function installAssistant(ctx, domain, profile, telemetry) {
  const observe = (name, fn) => (telemetry ? telemetry.run(name, fn) : fn())
  ctx.llm.registerAdapter(['claims-replay'], new ClaimsReplay())
  return async function assist(principal, input, reauthorize) {
    const { task, mode, itemId, expectedVersion } = input
    if (
      !profile.capabilities.includes(task) ||
      !['replay', 'live'].includes(mode) ||
      typeof itemId !== 'string' ||
      !Number.isInteger(expectedVersion) ||
      (input.question !== undefined && (typeof input.question !== 'string' || input.question.length > 1200))
    )
      throw new DomainError(400, 'invalid_assistant_request')
    const current = async () => {
      reauthorize()
      const detail = await domain.detail(principal, itemId)
      if (detail.item.version !== expectedVersion) throw new DomainError(409, 'stale_version')
      return detail
    }
    await current()
    const sessionId = 'session-' + randomUUID()
    const inputs = { sessionId, itemId, expectedVersion, mode, task, profileRelease: profile.release }
    await domain.bindSession(principal, inputs)
    const completedReads = new Set()
    let readSources = []
    let handle, timeout
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd(), agentPreset: profile.id },
        agentOptions: {
          provider: mode === 'live' ? 'claims-local' : 'claims-replay',
          model: mode === 'live' ? process.env.CLAIMS_MODEL_ID || 'claims-local' : 'fixture-v1',
          maxTokens: 700,
        },
        setup: async (scope, agent) => {
          await ctx.agentPresets.mount(scope, profile.id)
          scope.tools.restrict({ allow: [] })
          scope.tools.guard((call) =>
            profile.capabilities.includes(call.name)
              ? undefined
              : 'Only the claims review tools are available.',
          )
          // The claims persona suppresses runtime contexts. Override the stock
          // required directory entry in this scope so the suppression also covers it.
          scope.systemPrompt.context({
            name: 'working-directory:current',
            order: 0,
            required: false,
            text: '',
          })
          let steps = 0
          scope.on('agent/pre-step', async (e, next) => {
            if (e.agent !== agent) return next()
            if (++steps > 5) return { kind: 'reject' }
            await observe('assistant.check-scope', current)
            return next()
          })
          for (const name of profile.capabilities) {
            scope.tools.register({
              name,
              description: tasks[name],
              parameters: { type: 'object', properties: {}, additionalProperties: false },
              output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
              },
              execute: () =>
                observe('tool.' + name, async () => {
                  const detail = await current()
                  const bodies =
                    name === 'compare_evidence'
                      ? await Promise.all(
                          detail.evidence.slice(0, 12).map((e) => domain.evidence(principal, e.id)),
                        )
                      : []
                  if (name === 'compare_evidence')
                    readSources = bodies.map((e) => ({ ...e, body: e.body.slice(0, 900) }))
                  const result =
                    mode === 'live' && name === 'compare_evidence'
                      ? JSON.stringify(
                          bodies.map(({ id, title, body }) => ({ id, title, body: body.slice(0, 900) })),
                        )
                      : brief(name, detail, bodies).slice(0, 12000)
                  completedReads.add(name)
                  if (mode === 'live' && name === 'explain_priority') {
                    const { reason, nextAction, dueAt, ownerId } = detail.item
                    return JSON.stringify({ reason, nextAction, dueAt, ownerId })
                  }
                  return result
                }),
            })
          }
        },
      })
      const agent = handle.agent
      let expired = false
      timeout = setTimeout(() => {
        expired = true
        agent.cancel({ kind: 'user' })
      }, 90000)
      const extractive = mode === 'live' && task === 'compare_evidence'
      const format = extractive
        ? comparisonFormat
        : mode === 'live' && task === 'explain_priority'
          ? priorityFormat
          : ''
      const taskInstructions =
        'Call the tool named in task with empty arguments. Cite the exact source identifier or timeline source when answering. Use only facts from this tool.'
      const request = {
        task,
        request: input.question || tasks[task],
        subject: itemId,
        profileRelease: profile.release,
        instructions: format
          ? 'First call the tool named in task with empty arguments. ' + format
          : taskInstructions,
      }
      const firstOutput = await runTurn(agent, request, mode)
      let detail = await current()
      if (!completedReads.has(task)) throw new DomainError(422, 'assistant_did_not_read_selected_source')
      let text = firstOutput
      if (mode === 'live') {
        const grounded = (output) => {
          if (task === 'explain_priority') return renderPriority(output, detail)
          if (extractive) return renderComparison(output, readSources)
          const citations =
            task === 'timeline' ? detail.timeline.map((e) => e.source) : detail.evidence.map((e) => e.id)
          if (!citations.length) citations.push(detail.item.source)
          return citations.some((ref) => output.includes(ref)) ? output : null
        }
        text = grounded(firstOutput)
        if (!text) {
          const correction =
            format ||
            'Your answer requires the exact source identifier from the tool result. Return a short corrected answer with that citation.'
          if (expired) throw new DomainError(503, 'local_model_unavailable')
          const corrected = await runTurn(agent, { task, instructions: correction }, mode)
          detail = await current()
          text = grounded(corrected)
        }
        if (!text) throw new DomainError(422, 'unverified_source_response')
      }
      const answer = {
        mode,
        text,
        sessionId,
        profileRelease: profile.release,
        subject: itemId,
        revision: expectedVersion,
        sources: detail.evidence,
      }
      await domain.finishSession(principal, sessionId, answer)
      return answer
    } catch (error) {
      await domain.failSession(principal, sessionId)
      throw error
    } finally {
      clearTimeout(timeout)
      await handle?.dispose()
    }
  }
}
