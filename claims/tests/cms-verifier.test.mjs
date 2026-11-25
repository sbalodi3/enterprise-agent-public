import test from 'node:test'
import assert from 'node:assert/strict'
import { verifiedChatAnswer } from '../runtime/claim-chat.mjs'
import { createClaimReads } from '../runtime/chat-mcp.mjs'
import { parsePortfolioQuery, resolvePortfolioQuery } from '../runtime/portfolio-query.mjs'

const portfolio = { kind: 'portfolio' }
const claim = { kind: 'claim', claimIds: ['CLM-000017'] }
const receipt = { items: [], total: 0, asOf: '2026-11-17T14:00:00Z' }
test('a verified search card retains the recorded CMS loss description', () => {
  const filters = { status: 'open', lobs: ['AUTO','COMM_AUTO'], assignedOnly: true }
  const item = { id:'CLM-000040', title:'Commercial Auto · CLM-000040', lob:'COMM_AUTO', sourceStatus:'Open',
    nextAction:'View source extract', reason:'Frozen pipe burst overnight, flooded basement.' }
  const answer = verifiedChatAnswer(portfolio, 'List my open auto claims', '', { searches: [{ ...receipt, total:1, items:[item], filters }] })
  assert.equal(answer.cases.items[0].reason, item.reason)
})
function listing(question, filters) {
  return verifiedChatAnswer(portfolio, question, '', { cmsSummaryEnabled: true, searches: [{ ...receipt, filters }] })
}

test('summary verification preserves the named owner, business line and requested lifecycle', () => {
  const expected = { groupBy: 'lob', status: 'open', assignedOnly: false, ownerId: 'cms-adjuster-01', lob: 'COMM_AUTO' }
  const question = 'What are total billings for Aisha Khan’s open commercial auto claims?'
  const summary = { groups: [], groupBy: 'lob', total: 0, litigatedCount: 0, totalBillings: '0.00' }
  const verify = (question, filters) => verifiedChatAnswer(portfolio, question, '', {
    cmsSummaryEnabled: true, summaryFilters: filters, portfolioSummary: summary,
  })
  assert.deepEqual(verify(question, {}).requiredRead, { name: 'portfolio_summary', args: expected })
  assert.equal(verify(question, expected).summary, summary)
  assert.equal(verify('Show total billings for cms-adjuster-01 on open COMM_AUTO claims', expected).summary, summary)
  assert.equal(verify('Show total billings for Aisha Khan and Brandon Lee', {}).summary, undefined)
  assert.equal(verify('Show total billings for commercial auto and personal auto', {}).summary, undefined)
  assert.deepEqual(verify('Show total billings for Maya Chen', {}).requiredRead.args,
    { groupBy: 'lob', status: 'all', assignedOnly: false, ownerId: 'maya' })
})

test('portfolio totals require the requested source status, independently of grouping and lifecycle', () => {
  const summary = { groups: [], groupBy: 'lob', total: 20, litigatedCount: 3, totalBillings: '0.00' }
  function check(question, filters) {
    return verifiedChatAnswer(portfolio, question, '', { cmsSummaryEnabled: true, portfolioSummary: summary, summaryFilters: filters })
  }
  for (const [question, args] of [
    ['Total billings for denied claims', { sourceStatus: 'Denied' }],
    ['Portfolio summary for paid claims by adjuster', { groupBy: 'adjuster', sourceStatus: 'Paid' }],
    ['Portfolio summary for claims under investigation for Aisha Khan', { sourceStatus: 'Under Investigation', ownerId: 'cms-adjuster-01' }],
    ['Portfolio summary for the source status Closed', { status: 'closed', sourceStatus: 'Closed' }],
  ]) {
    assert.deepEqual(check(question, {}).requiredRead.args, { groupBy: 'lob', status: 'all', assignedOnly: false, ...args })
  }
  assert.equal(check('Total billings for denied claims', { sourceStatus: 'Denied' }).summary, summary)
  assert.equal(check('Total billings for closed claims', { status: 'closed' }).summary, summary)
  assert.equal(check('Total billings for closed claims', { status: 'closed', sourceStatus: 'Closed' }).requiredRead.args.sourceStatus, undefined)
})

test('verifier requires the full personal open or due cohort and keeps closed and denied claims personal', () => {
  assert.equal(listing('Show my open claims', { assignedOnly: true }).cases.explorable, true)
  for (const extra of [{ status: 'closed' }, { status: 'all' }, { lob: 'WC' }, { ownerId: 'cms-adjuster-01' }]) {
    assert.deepEqual(listing('Show my open claims', { assignedOnly: true, ...extra }).requiredRead.args,
      { assignedOnly: true })
    assert.deepEqual(listing('Which of my claims are due today?', { assignedOnly: true, dueToday: true, ...extra }).requiredRead.args,
      { assignedOnly: true, dueToday: true })
    assert.deepEqual(listing('Which claims are due today?', { dueToday: true, ...extra }).requiredRead.args,
      { assignedOnly: false, dueToday: true })
  }
  assert.deepEqual(listing('Show my closed claims', { status: 'closed' }).requiredRead.args, { status: 'closed', assignedOnly: true })
  assert.deepEqual(listing('Show my denied claims', { status: 'all', query: 'Denied' }).requiredRead.args,
    { status: 'all', assignedOnly: true, sourceStatus: 'Denied' })
})

test('auto lists and counts use the complete filtered cohort and keep follow-up ownership', () => {
  const question = 'Can you produce me a list of all open auto claims'
  const both = { status: 'open', assignedOnly: false, lobs: ['AUTO', 'COMM_AUTO'] }
  const mine = { ...both, assignedOnly: true }
  const plan = parsePortfolioQuery(question)
  assert.deepEqual(plan, { kind: 'portfolio', operation: 'list', filters: both })
  assert.deepEqual(parsePortfolioQuery('What are my open auto claims?').filters, mine)
  for (const [type, lob] of [['personal', 'AUTO'], ['commercial', 'COMM_AUTO']])
    assert.deepEqual(parsePortfolioQuery('Count my open ' + type + ' auto cases').filters, { status: 'open', assignedOnly: true, lob })
  assert.equal(parsePortfolioQuery('Which of my claims involve an interpreter?'), null)
  assert.equal(parsePortfolioQuery('Count open auto claims except mine'), null)
  assert.equal(parsePortfolioQuery('How many of those?'), null)
  assert.deepEqual(parsePortfolioQuery("What's the total?", plan).filters, both)
  assert.deepEqual(parsePortfolioQuery('How many of those are mine?', plan).filters, mine)
  const owned = { ...plan, filters: { ...both, ownerId: 'employee-other' } }
  assert.deepEqual(parsePortfolioQuery('How many of those are mine?', owned).filters, { ...mine, ownerId: 'employee-other' })
  for (const wrong of [{ ...both, assignedOnly: true }, { ...both, lobs: ['AUTO'] }, { ...both, offset: 12 }, { ...both, query: 'car' }])
    assert.deepEqual(listing(question, wrong).requiredRead, { name: 'search_claims', args: both })
  const state = { searches: [{ ...receipt, total: 29, items: [{ id: 'CLM-000017', title: 'Example', nextAction: 'Review' }], filters: mine }] }
  const list = verifiedChatAnswer(portfolio, 'List my open auto claims', '', state)
  assert.equal(list.cases.total, 29)
  assert.deepEqual(list.cases.filters, mine)
  const followup = 'How many of those?'
  const count = verifiedChatAnswer(portfolio, followup, '', { ...state, portfolioQuery: parsePortfolioQuery(followup, list.portfolioQuery) })
  assert.equal(count.cases, undefined)
  assert.match(count.text, /^29 matching claims/)
  assert.match(count.text, /Personal Auto · Commercial Auto · Assigned to me/)
  assert.doesNotMatch(count.text, /CLM-000017/)
})

test('portfolio MCP reads validate the business-line union and pass matching filters to the domain', async () => {
  const args = { status: 'open', lobs: ['AUTO','COMM_AUTO'], assignedOnly: true }
  const reads = createClaimReads({ scope: portfolio, principal: {}, signal: new AbortController().signal,
    allowed: ['search_claims'], reauthorize: async () => {}, domain: { async chatSearch(_, filters) {
      assert.deepEqual(filters, { ...args, limit: 12 })
      return { ...receipt, dependencies: [] }
    } } })
  await reads.call('search_claims', args)
  assert.deepEqual(reads.state().search.filters, args)
  for (const invalid of [{ lobs: [] }, { lobs: ['AUTO','AUTO'] }, { lobs: ['OTHER'] }, { ...args, lob: 'AUTO' }])
    await assert.rejects(reads.call('search_claims', invalid), { code: 'invalid_claim_tool_arguments' })
})

test('the semantic planner accounts for the wording of each filter before a cohort read', async () => {
  const first = 'Could you pull together an inventory of the auto cases still outstanding on my desk?'
  const second = "Bring up the open auto claims I'm managing"
  const filters = { status: 'open', assignedOnly: true, lobs: ['AUTO','COMM_AUTO'] }
  const cases = [[first, [
    { field: 'lifecycle', value: 'open', text: 'still outstanding' },
    { field: 'assignment', value: 'mine', text: 'on my desk' },
  ]], [second, [
    { field: 'assignment', value: 'mine', text: "I'm managing" },
  ]]]
  for (const [question, phrases] of cases) {
    const interpret = async value => { assert.equal(value, question); return {operation:'list', phrases, unsupported:[]} }
    const resolved = await resolvePortfolioQuery(question, null, interpret)
    assert.deepEqual(resolved.operation, {kind:'portfolio',operation:'list',filters})
    const wrong = verifiedChatAnswer(portfolio, question, '', {portfolioQuery:resolved.operation,
      searches:[{...receipt,filters:{status:'open', lob:'AUTO'}}]})
    assert.deepEqual(wrong.requiredRead, {name:'search_claims',args:filters})
  }
  const unsupported = 'Show my open auto claims with more than $500 in reserves'
  for (const proposed of [{operation:'list',phrases:[],unsupported:[]},
      {operation:'list',phrases:[],unsupported:['more than $500 in reserves']}, null]) {
    const resolved = await resolvePortfolioQuery(unsupported, null, async () => proposed)
    assert.equal(resolved.question.kind, 'portfolio')
    assert.equal(resolved.operation, undefined)
  }
  const dropped = await resolvePortfolioQuery(second, null, async () => ({operation:'list',unsupported:[],
    phrases:[{ field:'operation', value:'list', text:'Bring up' },
      {field:'line',value:'AUTO',text:'auto'}, {field:'assignment',value:'mine',text:"I'm managing"}]}))
  assert.equal(dropped.question.kind, 'portfolio')
  for (const request of ['Compare WC-101 and WC-102 across my claims', 'What are the total billings by adjuster?'])
    assert.equal(await resolvePortfolioQuery(request, null, () => { throw Error('Unexpected model call') }), null)
})

test('the selected claim brief preserves CMS fields and a status question reads the cited original passage', async () => {
  const domain = { detail: async () => ({ item: { claimNumber: claim.claimIds[0], sourceStatus: 'Denied', ownerId: 'maya',
    lifecycle: 'closed', lob: 'AUTO', policyNumber: 'POL-0000388', state: 'review', version: 2, title: 'Claim',
    source: 'CMS-MCP', reason: 'Roof damage.', nextAction: 'View source extract' } }) }
  const reads = createClaimReads({ domain, scope: claim, principal: { principalId: 'maya' },
    allowed: ['get_claim_brief'], signal: new AbortController().signal, reauthorize: async () => {} })
  const { structuredContent: brief } = await reads.call('get_claim_brief', {})
  assert.deepEqual([brief.sourceStatus, brief.lifecycle, brief.lob, brief.policyNumber, brief.state],
    ['Denied', 'closed', 'AUTO', 'POL-0000388', 'review'])
  const generic = verifiedChatAnswer(claim, 'Give me the brief', '', reads.state())
  assert.match(generic.text, /Source status: Denied\nCurrent owner: maya/)
  const status = () => verifiedChatAnswer(claim, 'What is its status?', '', reads.state())
  assert.equal(status().requiredRead.name, 'list_evidence')
  const docId = claim.claimIds[0] + '-extract'
  reads.state().inventory.set(claim.claimIds[0], [{ documentId: docId, passages: [{ anchorId: 'identity' }] }])
  assert.deepEqual(status().requiredRead.args, { claimId: claim.claimIds[0], documentId: docId, anchorId: 'identity' })
  reads.state().reads.push({ claimId: claim.claimIds[0], documentId: docId, anchorId: 'identity', title: 'Claim extract', quote: 'Source status: Denied.' })
  assert.equal(status().sources[0].anchorId, 'identity')
})
