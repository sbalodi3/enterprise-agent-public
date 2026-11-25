import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createChatHost } from './chat-host-fixture.mjs'
import { LlmAdapter } from '../../packages/llm/llm/lib/index.js'
import { installClaimChat, verifiedChatAnswer } from '../runtime/claim-chat.mjs'
import { createClaimReads, startClaimMcp } from '../runtime/chat-mcp.mjs'
import { getDocument } from '../showcase/data/documents.mjs'
import { claims } from '../showcase/data/scenario.mjs'

const profile = JSON.parse(await readFile(new URL('../profiles/claims-v1.json', import.meta.url)))
const scope = { kind: 'claim', claimIds: ['WC-103'] }
const records = new Map(
  claims.map((i) => [
    i.id,
    { item: { ...i, version: 1 }, showcase: { documents: i.documents.map(getDocument) }, timeline: [] },
  ]),
)
const domain = {
  detail: async (_, id) => {
    assert.ok(records.has(id))
    return records.get(id)
  },
  chatEvidenceIndex: async (_, selected, id) => {
    const ids = selected.kind === 'document' ? [selected.documentId] : selected.documents?.[id]
    return { item: { version: 1 }, documents: records.get(id).showcase.documents.filter(d => !ids || ids.includes(d.id)) }
  },
  chatSource: async (_, { claimId, documentId }) =>
    records.get(claimId).showcase.documents.find((doc) => doc.id === documentId),
}
// Script only the provider responses. The MCP transport, native agent loop, tool runtime,
// evidence verification and timeline execute exactly as in the live product.
class FixtureModel extends LlmAdapter {
  constructor(script, respond) {
    super()
    this.script = script
    this.respond = respond
  }
  async *stream({ messages }) {
    const question = messages.find((m) => m.role === 'user')?.content[0].text || ''
    const count = messages.filter((m) => m.role === 'tool').length
    const calls =
      this.script ??
      (question.includes('Show me the timeline')
        ? [['claim_timeline', {}]]
        : [
            ['list_evidence', {}],
            ['read_evidence', { documentId: 'WC-103-report', anchorId: 'account' }],
            ['read_evidence', { documentId: 'WC-103-shift', anchorId: 'date' }],
          ])
    if (count < calls.length) {
      const [raw, args] = calls[count],
        name = 'mcp__claims__' + raw,
        id = 'test-' + count,
        json = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = this.respond?.(JSON.parse(question)) ?? 'An unsupported conclusion deliberately emitted by the test model.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('attached claim facts and selected excerpts answer from a fresh protected prompt', async t => {
  const ctx = await createChatHost(t, profile)
  let choose = () => '{"brief":true}'
  const calls = []
  ctx.llm.registerAdapter(['claims-local'],new FixtureModel([], prompt => choose(prompt)))
  const run = installClaimChat(ctx,{domain,profile})
  const options = {scope,plan:{kind:'claim'},principal:{},reauthorize:async()=>{},onActivity: e => { if (e.tool) calls.push(e.tool) }}
  choose = ({attached}) => {
    assert.equal(attached.briefs[0].claimId,'WC-103')
    assert.equal(attached.documents.length,2)
    assert.deepEqual(attached.excerpts,[])
    return '{"brief":true}'
  }
  const brief = await run({...options,question:'What is the claim brief?'})
  assert.match(brief.text,/WC-103/)
  choose = ({attached}) => {
    assert.deepEqual(attached.briefs,[])
    assert.deepEqual(attached.documents.map(d=>d.documentId),['WC-103-report'])
    assert.ok(attached.excerpts.every(e=>e.documentId==='WC-103-report'))
    const excerpt = attached.excerpts.find(e=>e.anchorId==='account')
    return JSON.stringify({sources:[excerpt.sourceId]})
  }
  const quoted = await run({...options,scope:{...scope,documents:{'WC-103':['WC-103-report']}},question:'What date is reported?'})
  assert.deepEqual(quoted.sources.map(s=>[s.documentId,s.anchorId]),[['WC-103-report','account']])
  assert.match(quoted.text,/November 9/)
  choose = () => '{"ask":{"question":"Which format would you like?","options":["Timeline","Summary"]}}'
  const pending = await run({...options,question:'Prepare my review.'})
  assert.deepEqual(pending.pendingQuestion.options.map(o=>o.label),['Timeline','Summary'])
  choose = ({clarifications}) => {
    assert.deepEqual(clarifications,[{question:'Which format would you like?',answer:['Summary']}])
    return '{"brief":true}'
  }
  await run({...options,question:'Prepare my review.',clarifications:[{question:pending.pendingQuestion,answer:{selected:['choice-2']}}]})
  assert.deepEqual(calls,[])
})

test('native session discovers scoped MCP tools, reads both WC-103 originals, then mounts the timeline on a fresh turn', async (t) => {
  const ctx = await createChatHost(t, profile)
  ctx.llm.registerAdapter(['claims-local'], new FixtureModel())
  const turn = installClaimChat(ctx, { profile, domain })
  const reads = []
  const options = {
    scope,
    principal: {},
    reauthorize: async () => {},
    onActivity: (event, deps) => {
      if (event.tool && event.state === 'completed') reads.push([event.tool, deps.length])
    },
  }
  const dates = await turn({ ...options, question: 'Why are there two incident dates?' })
  assert.deepEqual(
    reads.map(([name]) => name),
    ['list_evidence', 'read_evidence', 'read_evidence'],
  )
  assert.ok(reads.every(([, deps]) => deps > 0))
  assert.deepEqual(
    dates.sources.map(({ documentId, anchorId }) => [documentId, anchorId]),
    [
      ['WC-103-report', 'account'],
      ['WC-103-shift', 'date'],
    ],
  )
  assert.match(dates.text, /November 9/)
  assert.match(dates.text, /November 10/)
  assert.match(dates.text, /remains to be verified/)
  assert.doesNotMatch(dates.text, /unsupported conclusion/)
  const timeline = await turn({
    ...options,
    question: 'Show me the timeline',
    history: [{ state: 'completed', question: 'Why are there two incident dates?', answer: dates }],
  })
  assert.equal(reads.at(-1)[0], 'claim_timeline')
  assert.deepEqual(
    timeline.timeline.sources.map((s) => s.at),
    ['2026-11-09T19:15:00.000Z', '2026-11-17T14:00:00.000Z'],
  )
  assert.deepEqual(
    timeline.sources.map((s) => s.documentVersion),
    [1, 1],
  )
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/wc-103-claim-chat.json', import.meta.url)))
  assert.deepEqual(
    {
      toolCalls: reads.map(([name]) => name),
      sources: dates.sources,
      recordedAt: timeline.timeline.sources.map((s) => s.at),
    },
    snapshot,
  )
})

test('a whole-claim wage turn gives the model only verified ordering choices and persists the selected order', async t => {
  const old = process.env.CLAIMS_WAGE_REVIEW
  process.env.CLAIMS_WAGE_REVIEW = '1'
  t.after(() => { if (old === undefined) delete process.env.CLAIMS_WAGE_REVIEW; else process.env.CLAIMS_WAGE_REVIEW = old })
  const ctx = await createChatHost(t, profile)
  let order
  ctx.llm.registerAdapter(['claims-local'], new FixtureModel([], ({layout}) => {
    assert.ok(layout.facts.every(f => Object.keys(f).sort().join() === 'component,id'))
    order = layout.facts.map(f => f.id).reverse()
    return JSON.stringify({order})
  }))
  const result = await installClaimChat(ctx, {profile,domain})({principal:{}, scope:{kind:'claim',claimIds:['WC-102']},
    question:'Review missing wage evidence.', reauthorize:async () => {}})
  assert.equal(result.wageReview.layout, 'model')
  assert.deepEqual(result.wageReview.messages[1].updateComponents.components.filter(c=>c.id.startsWith('fact_') && c.component !== 'SourceLink').map(c=>c.id),order)
  assert.ok(result.dependencies.some(d => d.documentId === 'WC-102-report'))
  assert.ok(result.activity.some(a => a.tool === 'review_wage_evidence' && a.state === 'completed'))
})

test('portfolio MCP discovery serves the bundled case app declared by search_claims', async t => {
  const signal = new AbortController().signal
  const reads = createClaimReads({ domain, principal: {}, scope: { kind: 'portfolio' }, allowed: profile.chatTools,
    reauthorize: async () => {}, signal })
  const conn = await startClaimMcp(reads, signal)
  t.after(conn.close)
  async function rpc(method, params) {
    const response = await fetch(conn.url, { method: 'POST', headers: { authorization: conn.authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return response.json()
  }
  const { tools } = (await rpc('tools/list')).result
  const uri = tools.find(tool => tool.name === 'search_claims')._meta.ui.resourceUri
  const { resources } = (await rpc('resources/list')).result
  assert.deepEqual(resources.map(resource => resource.uri), [uri])
  const [asset] = (await rpc('resources/read', { uri })).result.contents
  assert.equal(asset.mimeType, 'text/html;profile=mcp-app')
  assert.match(asset.text, /ui\/open-link/)
  assert.ok((await rpc('resources/read', { uri: 'ui://enterprise-agent/unknown' })).error)
})

test('document scope restricts discovery and refuses unrelated IDs, including direct protocol requests', async (t) => {
  const ctl = new AbortController()
  const reads = createClaimReads({
    domain,
    principal: {},
    scope: { ...scope, kind: 'document', documentId: 'WC-103-report' },
    allowed: profile.chatTools,
    reauthorize: async () => {},
    signal: ctl.signal,
  })
  assert.deepEqual(
    reads.tools.map((t) => t.name),
    ['list_evidence', 'read_evidence'],
  )
  const conn = await startClaimMcp(reads, ctl.signal)
  t.after(conn.close)
  assert.equal((await fetch(conn.url, { method: 'POST' })).status, 403)
  assert.equal(
    (
      await fetch(conn.url, {
        method: 'POST',
        headers: { authorization: conn.authorization, origin: 'http://localhost' },
      })
    ).status,
    403,
  )
  const list = await reads.call('list_evidence', {})
  assert.deepEqual(
    list.structuredContent.documents.map((d) => d.documentId),
    ['WC-103-report'],
  )
  await assert.rejects(reads.call('read_evidence', { documentId: 'WC-103-shift', anchorId: 'date' }), {
    code: 'use_selected_claim_or_document',
  })
  await assert.rejects(reads.call('read_evidence', { documentId: 'WC-103-report', anchorId: 'forged' }), {
    code: 'select_listed_document_and_anchor',
  })
  ctl.abort()
  await conn.close()
  await assert.rejects(fetch(conn.url))
})

test('document selections restrict inventory, summary, original passages and every timeline projection', async () => {
  const subset = { kind: 'multi', claimIds: ['WC-103','WC-104'], documents: { 'WC-103': ['WC-103-report'] } }
  const opts = { domain, scope: subset, principal: {}, allowed: profile.chatTools, reauthorize: async () => {},
    signal: new AbortController().signal }
  const reads = createClaimReads(opts)
  const claimId = 'WC-103'
  const listed = (await reads.call('list_evidence', { claimId })).structuredContent
  assert.deepEqual(listed.documents.map(d => d.documentId), ['WC-103-report'])
  await assert.rejects(reads.call('read_evidence', { claimId, documentId: 'WC-103-shift', anchorId: 'date' }),
    { code: 'use_selected_claim_or_document' })
  await assert.rejects(reads.call('get_claim_brief', { claimId }), { code: 'use_selected_claim_or_document' })
  await reads.call('get_claim_brief', { claimId: 'WC-104' })
  await reads.call('claim_timeline', { claimId })
  await reads.call('claim_timeline', { claimId: 'WC-104' })
  const timeline = verifiedChatAnswer(subset, 'Show timelines', '', reads.state())
  assert.doesNotMatch(JSON.stringify(timeline), /WC-103-shift|handover|November 10/)
  assert.deepEqual(timeline.sources.map(s => s.documentId).sort(), ['WC-103-report','WC-104-report'])
  const one = { ...scope, documents: subset.documents }
  const single = createClaimReads({ ...opts, scope: one })
  assert.ok(!single.tools.some(t => t.name === 'get_claim_brief'))
  assert.equal(verifiedChatAnswer(one, 'What does this say?', '', single.state()).requiredRead.name, 'list_evidence')
  await single.call('list_evidence', {})
  assert.equal(verifiedChatAnswer(one, 'What does this say?', '', single.state()).requiredRead.name, 'read_evidence')
  await single.call('read_evidence', { documentId: 'WC-103-report', anchorId: 'account' })
  const dates = verifiedChatAnswer(one, 'Why are there conflicting dates?', '', single.state())
  assert.match(dates.text, /One document is selected/)
  assert.doesNotMatch(dates.text, /November 10/)
  await single.call('claim_timeline', {})
  const visual = verifiedChatAnswer(one, 'Show the timeline', '', single.state())
  assert.deepEqual(visual.timeline.events, [])
  assert.deepEqual(visual.timeline.sources.map(s => s.id), ['WC-103-report'])
  assert.deepEqual(createClaimReads({ ...opts, scope: { kind: 'workspace' } }).tools, [])
})

test('portfolio comparison suggestions are limited to IDs actually returned by a read', () => {
  const state = {
    search: { items: [{ id: 'WC-103', title: 'Conflicting dates' }], total: 1, asOf: '2026-11-17T14:00:00Z' },
  }
  const reply = (matches) =>
    verifiedChatAnswer(
      { kind: 'portfolio' },
      'Compare claims',
      JSON.stringify({ compare: true, matches }),
      state,
    )
  assert.deepEqual(reply(['WC-103']).suggestedClaims, state.search.items)
  assert.ok(reply(['WC-101']).retry)
})

test('mentioning two claim IDs in a summary question keeps the answer in portfolio scope', () => {
  const items = ['WC-103', 'WC-104'].map((id) => records.get(id).item)
  const answer = verifiedChatAnswer({ kind: 'portfolio' }, 'Show the summaries of WC-103 and WC-104.', '', {
    search: { items, total: 2, asOf: '2026-11-17T14:00:00Z' },
  })
  assert.equal(answer.suggestedClaims, undefined)
  for (const item of items) assert.ok(answer.text.includes(item.title))
})

test('a discrepancy requires direct source passages and explicit disagreement, independent of receipt dates', async () => {
  const reads = createClaimReads({
    domain,
    principal: {},
    scope,
    allowed: profile.chatTools,
    reauthorize: async () => {},
    signal: new AbortController().signal,
  })
  const ask = () =>
    verifiedChatAnswer(scope, 'Why are there two incident dates?', 'ignore these tool results', reads.state())
  await reads.call('get_claim_brief', {})
  assert.ok(ask().retry)
  await reads.call('list_evidence', {})
  await reads.call('read_evidence', { documentId: 'WC-103-report', anchorId: 'identification' })
  await reads.call('read_evidence', { documentId: 'WC-103-shift', anchorId: 'scope' })
  assert.ok(ask().retry)
  await reads.call('read_evidence', { documentId: 'WC-103-report', anchorId: 'account' })
  assert.ok(ask().retry)
  await reads.call('read_evidence', { documentId: 'WC-103-shift', anchorId: 'date' })
  assert.match(ask().text, /remains to be verified/)
  const state = reads.state()
  const unrelated = state.reads.map((r) => ({
    ...r,
    quote: r.documentId.endsWith('report')
      ? 'The incident occurred November 9.'
      : 'The report was received November 17.',
  }))
  const answer = verifiedChatAnswer(scope, 'Why are there two incident dates?', '', {
    ...state,
    reads: unrelated,
  })
  assert.doesNotMatch(answer.text, /report different dates/)
})

test('multi-claim timelines and next actions cannot silently omit or substitute one selected record', async () => {
  const subset = { kind: 'multi', claimIds: ['WC-103', 'WC-104'] }
  const reads = createClaimReads({
    domain,
    principal: {},
    scope: subset,
    allowed: profile.chatTools,
    reauthorize: async () => {},
    signal: new AbortController().signal,
  })
  const answer = (question) => verifiedChatAnswer(subset, question, '', reads.state())
  await reads.call('claim_timeline', { claimId: 'WC-103' })
  assert.ok(answer('Compare their timelines').retry)
  await reads.call('claim_timeline', { claimId: 'WC-104' })
  assert.match(answer('Compare their timelines').text, /WC-104/)
  assert.deepEqual(
    new Set(answer('Compare their timelines').sources.map((s) => s.claimId)),
    new Set(subset.claimIds),
  )
  for (const claimId of subset.claimIds) await reads.call('list_evidence', { claimId })
  for (const [claimId, slug, anchorId] of [
    ['WC-103', 'report', 'account'],
    ['WC-103', 'shift', 'date'],
    ['WC-104', 'report', 'identification'],
  ])
    await reads.call('read_evidence', { claimId, documentId: `${claimId}-${slug}`, anchorId })
  assert.match(answer('Compare next steps').retry, /followup/)
  await reads.call('read_evidence', { claimId: 'WC-104', documentId: 'WC-104-report', anchorId: 'followup' })
  assert.match(answer('Compare next steps').text, /18:00 UTC/)
  const mixed = answer('Compare the conflicting dates on WC-103 and the next action on WC-104.')
  assert.match(mixed.text, /November 9/)
  assert.match(mixed.text, /18:00 UTC/)
  assert.ok(mixed.sources.some((s) => s.claimId === 'WC-104' && s.anchorId === 'followup'))
})

test('withdrawing access after a document read prevents releasing the excerpt and its activity title', async () => {
  const { DomainError } = await import('../domain/index.mjs')
  let moved = false
  const entries = []
  const changingDomain = {
    ...domain,
    async chatSource(principal, ref) {
      const source = await domain.chatSource(principal, ref)
      moved = true
      return source
    },
  }
  const reads = createClaimReads({
    domain: changingDomain,
    principal: {},
    scope,
    allowed: profile.chatTools,
    reauthorize: async () => {
      if (moved) throw new DomainError(404, 'not_found')
    },
    onActivity: (entry) => entries.push(entry),
    signal: new AbortController().signal,
  })
  await assert.rejects(reads.call('read_evidence', { documentId: 'WC-103-report', anchorId: 'account' }), {
    code: 'not_found',
  })
  assert.ok(entries.every((entry) => !entry.label.includes('Supervisor incident report')))
  await assert.rejects(reads.check(), { code: 'not_found' })
})

test('multi-claim reads infer an omitted claim only from documents already listed under this selection', async () => {
  const scope = { kind: 'multi', claimIds: ['WC-103', 'WC-104'] }
  const reads = createClaimReads({
    domain,
    principal: {},
    scope,
    allowed: profile.chatTools,
    reauthorize: async () => {},
    signal: new AbortController().signal,
  })
  const args = { documentId: 'WC-103-report', anchorId: 'account' }
  await assert.rejects(reads.call('read_evidence', args), { code: 'use_selected_claim_or_document' })
  await reads.call('list_evidence', { claimId: 'WC-103' })
  assert.equal((await reads.call('read_evidence', args)).structuredContent.claimId, 'WC-103')
  await assert.rejects(reads.call('read_evidence', { ...args, claimId: 'WC-101' }), {
    code: 'use_selected_claim_or_document',
  })
  await assert.rejects(
    reads.call('read_evidence', { ...args, anchorId: 'date' }),
    (e) => e.code === 'select_listed_document_and_anchor' && /account \(Source account\)/.test(e.repair),
  )
})

test('portfolio comparisons retain every explicitly named and verified ID across separate tool searches', async () => {
  const scope = { kind: 'portfolio' }
  const searchDomain = {
    chatSearch: async (_, args) => {
      const ids = ['WC-103', 'WC-104'].filter((id) => !args.query || id === args.query)
      return {
        items: ids.map((id) => records.get(id).item),
        total: ids.length,
        asOf: '2026-11-17T14:00:00Z',
        dependencies: ids.map((claimId) => ({ claimId, claimVersion: 1 })),
      }
    },
  }
  const reads = createClaimReads({
    domain: searchDomain,
    scope,
    principal: {},
    allowed: profile.chatTools,
    reauthorize: async () => {},
    signal: new AbortController().signal,
  })
  const question = 'Compare next steps and documents for wc-103 and WC-104.'
  const finish = (question) =>
    verifiedChatAnswer(scope, question, '{"compare":true,"matches":["WC-104"]}', reads.state())
  assert.deepEqual(finish(question).requiredRead, {
    name: 'search_claims',
    args: { query: 'WC-103', assignedOnly: false, dueToday: false },
  })
  await reads.call('search_claims', { query: 'WC-104' })
  assert.match(finish(question).retry, /WC-103/)
  await reads.call('search_claims', { query: 'WC-103' })
  assert.deepEqual(
    finish(question).suggestedClaims.map((s) => s.id),
    ['WC-103', 'WC-104'],
  )
  assert.deepEqual(finish(question).sources, [])
  const missing = 'Compare WC-999 and WC-104.'
  assert.match(finish(missing).retry, /WC-999/)
  assert.equal(finish(missing).requiredRead.args.query, 'WC-999')
  await reads.call('search_claims', { query: 'WC-999' })
  assert.match(finish(missing).text, /1 of the 2 named claims/)
  assert.deepEqual(
    finish(missing).suggestedClaims.map((s) => s.id),
    ['WC-104'],
  )
  assert.deepEqual(
    reads.tools.map((t) => t.name),
    ['search_claims'],
  )
})

const deadlineQuestion = 'Which of my assigned claims have a deadline later today?'
const deadlineFilters = { assignedOnly: true, dueToday: true }
const deadlineIds = ['WC-108', 'WC-104']
const deadlineReceipt = (ids, filters) => ({
  total: ids.length,
  items: ids.map((id) => records.get(id).item),
  asOf: '2026-11-17T14:00:00Z',
  filters,
  dependencies: ids.map((claimId) => ({ claimId, claimVersion: 1 })),
})

test('a resumed deadline listing repeats the authorized search through MCP without remembered claim IDs', async (t) => {
  const ctx = await createChatHost(t, profile)
  const stale = { query: 'WC-108, WC-104', ...deadlineFilters }
  ctx.llm.registerAdapter(['claims-local'], new FixtureModel([['search_claims', stale]]))
  const calls = []
  const searchDomain = {
    chatSearch: async (_, args) => {
      calls.push(args)
      return deadlineReceipt(args.query ? [] : deadlineIds, args)
    },
  }
  const run = installClaimChat(ctx, { profile, domain: searchDomain })
  const answer = await run({
    principal: {},
    scope: { kind: 'portfolio' },
    question: deadlineQuestion,
    reauthorize: async () => {},
    history: [
      { state: 'completed', question: 'Which claims did I review?', answer: { text: 'WC-108, WC-104' } },
    ],
  })
  assert.deepEqual(calls, [
    { ...stale, limit: 12 },
    { ...deadlineFilters, limit: 12 },
  ])
  assert.deepEqual(
    answer.activity.filter((a) => a.tool).map((a) => [a.tool, a.origin]),
    [
      ['search_claims', 'model'],
      ['search_claims', 'verifier'],
    ],
  )
  assert.match(answer.text, /^2 matching claims[\s\S]*WC-108[\s\S]*4:30 PM[\s\S]*WC-104[\s\S]*6:00 PM/)
  assert.equal(answer.suggestedClaims, undefined)
  assert.deepEqual(answer.sources, [])
})

test('open case listings require a verified first page of the employee’s assigned open claims', () => {
  const finish = searches => verifiedChatAnswer(
    { kind: 'portfolio' }, 'What are my open cases?', '', { searches, search: searches.at(-1) },
  )
  for (const filters of [{}, { assignedOnly: true, query: 'WC-104' }, { assignedOnly: true, offset: 12 }, deadlineFilters]) {
    assert.deepEqual(finish([deadlineReceipt(deadlineIds, filters)]).requiredRead, {
      name: 'search_claims', args: { assignedOnly: true },
    })
  }
  assert.match(finish([deadlineReceipt(['WC-104'], { assignedOnly: true })]).text, /^1 open claim[\s\S]*WC-104/)
  const empty = finish([deadlineReceipt([], { assignedOnly: true })])
  assert.match(empty.text, /^0 open claims/)
  assert.deepEqual(empty.cases.items, [])
  assert.equal(empty.cases.view, 'open')
})

test('waiting and due case cards require their own whole-cohort query', () => {
  const finish = (question, filters) => verifiedChatAnswer({ kind: 'portfolio' }, question, '',
    { searches: [deadlineReceipt(['WC-104'], filters)] })
  const waiting = { assignedOnly: true, waitingOnly: true }
  const question = 'Which of my cases are waiting?'
  assert.deepEqual(finish(question, deadlineFilters).requiredRead.args, waiting)
  assert.equal(finish(question, waiting).cases.view, 'waiting')
  assert.deepEqual(finish('What are my open cases?', waiting).requiredRead.args, { assignedOnly: true })
  assert.equal(finish('Which of my cases are due today?', deadlineFilters).cases.view, 'due')
})

test('deadline verification accepts the matching receipt, preserves subject filters, and requires the requested ownership and first page', () => {
  const whole = deadlineReceipt(deadlineIds, deadlineFilters)
  const narrow = deadlineReceipt(['WC-108'], { ...deadlineFilters, query: 'interpreter' })
  const finish = (question, searches, output = '') =>
    verifiedChatAnswer({ kind: 'portfolio' }, question, output, { searches, search: searches.at(-1) })
  const result = finish(deadlineQuestion, [whole, narrow], '{"compare":true,"matches":["WC-108"]}')
  assert.match(result.text, /^2 matching claims/)
  assert.equal(result.suggestedClaims, undefined)
  for (const searches of [
    [],
    [narrow],
    [deadlineReceipt([], { ...deadlineFilters, offset: 12 })],
    [deadlineReceipt([], { dueToday: true })],
  ])
    assert.deepEqual(finish(deadlineQuestion, searches).requiredRead, {
      name: 'search_claims',
      args: deadlineFilters,
    })
  assert.deepEqual(finish('Which claims are due today?', [whole]).requiredRead.args, {
    dueToday: true,
    assignedOnly: false,
  })
  for (const phrase of ['interpreter claims', 'claims for WC-108'])
    assert.match(
      finish(`Which of my assigned ${phrase} have a deadline later today?`, [narrow]).text,
      /^1 matching claim/,
    )
})

test('a resumed date question repairs the missing verified source through MCP after the model repeats a historical timeline', async (t) => {
  const ctx = await createChatHost(t, profile)
  ctx.llm.registerAdapter(
    ['claims-local'],
    new FixtureModel([
      ['claim_timeline', {}],
      ['list_evidence', {}],
      ['read_evidence', { documentId: 'WC-103-shift', anchorId: 'date' }],
    ]),
  )
  let turn
  // Exercise the private plugin owner used in deployment. The verifier should
  // dispatch via the agent's plugin scope even if this route has no root tools grant.
  await ctx.plugin({
    name: 'claim-conversation-route-test',
    inject: ['agents', 'agentPresets'],
    apply(owner) {
      turn = installClaimChat(owner, { profile, domain })
    },
  })
  const history = [
    { state: 'completed', question: 'Show me the timeline', answer: { text: 'Earlier recorded events.' } },
  ]
  const result = await turn({
    principal: {},
    scope,
    history,
    question: 'Why are there two incident dates?',
    reauthorize: async () => {},
  })
  const calls = result.activity.filter((step) => step.tool && step.state === 'completed')
  assert.deepEqual(
    calls.map((step) => [step.tool, step.origin]),
    [
      ['claim_timeline', 'model'],
      ['list_evidence', 'model'],
      ['read_evidence', 'model'],
      ['read_evidence', 'verifier'],
    ],
  )
  assert.match(calls.at(-1).label, /Verifier.*Supervisor incident report/)
  assert.deepEqual(
    result.sources.map((s) => [s.documentId, s.anchorId]),
    [
      ['WC-103-shift', 'date'],
      ['WC-103-report', 'account'],
    ],
  )
  assert.match(result.text, /November 9/)
  assert.match(result.text, /November 10/)
  assert.equal(result.timeline, undefined)
})

test('a timeline question retrieves the missing timeline after a completed live model response', async (t) => {
  const ctx = await createChatHost(t, profile)
  ctx.llm.registerAdapter(['claims-local'], new FixtureModel([]))
  const run = installClaimChat(ctx, { profile, domain })
  const answer = await run({
    principal: {},
    scope,
    question: 'Show me the timeline',
    reauthorize: async () => {},
  })
  assert.equal(answer.timeline.itemId, 'WC-103')
  assert.deepEqual(
    answer.activity.filter((a) => a.tool).map((a) => [a.tool, a.origin]),
    [['claim_timeline', 'verifier']],
  )
})

test('a provider outage never triggers verifier reads or publishes a synthetic answer', async (t) => {
  const ctx = await createChatHost(t, profile)
  class OfflineModel extends LlmAdapter {
    async *stream() {
      throw Error('Local test model offline')
    }
  }
  ctx.llm.registerAdapter(['claims-local'], new OfflineModel())
  const run = installClaimChat(ctx, { profile, domain }),
    activity = []
  await assert.rejects(
    run({
      principal: {},
      scope,
      question: 'Why are there two incident dates?',
      reauthorize: async () => {},
      onActivity: (e) => activity.push(e),
    }),
    { code: 'local_model_unavailable' },
  )
  assert.deepEqual(activity, [])
})

test('a verifier read that loses its source cannot finalize the comparison', async (t) => {
  const { DomainError } = await import('../domain/index.mjs')
  const ctx = await createChatHost(t, profile)
  ctx.llm.registerAdapter(
    ['claims-local'],
    new FixtureModel([
      ['list_evidence', {}],
      ['read_evidence', { documentId: 'WC-103-shift', anchorId: 'date' }],
    ]),
  )
  const staleDomain = {
    ...domain,
    async chatSource(principal, ref) {
      if (ref.documentId === 'WC-103-report') throw new DomainError(409, 'stale_version')
      return domain.chatSource(principal, ref)
    },
  }
  const activity = []
  const run = installClaimChat(ctx, { profile, domain: staleDomain })
  await assert.rejects(
    run({
      principal: {},
      scope,
      question: 'Why are there two incident dates?',
      reauthorize: async () => {},
      onActivity: (row) => activity.push(row),
    }),
    { code: 'stale_version' },
  )
  assert.ok(
    activity.some(
      (row) => row.tool === 'read_evidence' && row.origin === 'verifier' && row.state === 'failed',
    ),
  )
  assert.ok(activity.every((row) => row.id !== 'verify'))
})

test('unavailable verifier dispatch is distinguished from a provider outage after successful inference', async (t) => {
  const ctx = await createChatHost(t, profile)
  ctx.llm.registerAdapter(['claims-local'], new FixtureModel([]))
  const run = installClaimChat(ctx, { profile, domain })
  await assert.rejects(
    run({
      principal: {},
      scope,
      question: 'Show me the timeline',
      reauthorize: async () => {},
      onActivity: (row) => {
        if (row.origin === 'verifier') throw Error('Fixture verifier publisher unavailable')
      },
    }),
    { status: 503, code: 'chat_verifier_unavailable' },
  )
})
