import test from 'node:test'
import assert from 'node:assert/strict'
import { decideScope, planClaimRequest, routeClaimsPrompt } from '../runtime/scope-router.mjs'
import { claims } from '../showcase/data/scenario.mjs'
import { getDocument } from '../showcase/data/documents.mjs'
import { DomainError } from '../domain/index.mjs'

const alex = { principalId: 'alex', tenantId: 'demo', profileId: 'claims-v1', subject: 'employee-alex' }
const maya = { ...alex, principalId: 'maya', subject: 'employee-maya' }
const blank = { kind: 'workspace' }
const claim = (...claimIds) => ({ kind: claimIds.length === 1 ? 'claim' : 'multi', claimIds })
const selected = { ...claim('WC-103'), documents: { 'WC-103': ['WC-103-report'] } }
const predict = (intent, confidence = .93, margin = .8) => async () => ({
  intent, confidence, margin, version: 'scope-minilm-111111111111',
})

function catalog(items = claims, documents = getDocument) {
  return {
    async chatSearch(ctx, { status, offset, limit }) {
      assert.equal(status, 'all')
      const assigned = items.filter(row => row.ownerId === ctx.principalId)
      return { items: assigned.slice(offset, offset + limit), total: assigned.length }
    },
    async chatDocuments(ctx, id) {
      const parent = items.find(row => row.id === id && row.ownerId === ctx.principalId)
      if (!parent) throw new DomainError(404, 'not_found')
      return { items: parent.documents.map(docId => {
        const { id, title } = documents(docId)
        return { id, title }
      }) }
    },
    async assertChatScope(ctx, scope) {
      if (scope.claimIds?.some(id => !items.some(row => row.id === id && row.ownerId === ctx.principalId)))
        throw new DomainError(404, 'not_found')
    },
  }
}
const domain = catalog()
test('action drafts keep selected documents and ignore claim IDs inside note text', async () => {
  const plan = (question,scope) => planClaimRequest({domain,ctx:alex,question,pins:scope,focus:scope})
  assert.deepEqual((await plan('Create a note for WC-103: called the employer',selected)).scope,selected)
  assert.deepEqual((await plan('Create a note: compare with WC-102',claim('WC-103'))).scope,claim('WC-103'))
  assert.deepEqual((await plan('Set priority to high for WC-103',blank)).scope,claim('WC-103'))
})
test('protected planning and preflight trace only routing categories', async () => {
  const tags = []
  const trace = {run:(_name, callback) => callback(null,null,null,fields => tags.push(fields))}
  await routeClaimsPrompt({ctx:alex,domain,trace,input:{preflight:true,question:'Open WC-103 and save the result to report.md',scope:blank}})
  const row = {claimId:'WC-103',claimVersion:1,title:'Private delivery',matches:1}
  const result = await planClaimRequest({ctx:alex,trace,domain:{chatTargetCandidates:async()=>[row]},
    question:'Find the claim involving a private delivery van'})
  assert.equal(result.question.kind,'candidate')
  assert.deepEqual(tags,[{'routing.action':'clarify'},{'routing.action':'clarify','routing.intent':'clarify','routing.additions':0}])
})
const decide = (question, options = {}) => decideScope({
  ctx: options.ctx ?? alex, domain: options.domain ?? domain,
  classify: options.classify ?? predict('claim'), input: { scope: blank, ...options.input, question },
})

test('clear IDs resolve through the authorized catalog including closed files, even offline', async () => {
  for (const text of ['Can we go over WC-103?', 'Please investigate WC-103.', 'Walk me through WC-103.']) {
    const response = await decide(text, { classify: async () => null })
    assert.equal(response.action, 'claims')
    assert.deepEqual(response.scope, claim('WC-103'))
    assert.deepEqual(response.added, [{ claimId: 'WC-103' }])
    assert.equal(response.version, 'offline')
  }
  assert.deepEqual((await decide('Compare WC-103 with WC-114')).scope, claim('WC-103','WC-114'))
  const denied = await decide('Open WC-103', { ctx: maya })
  assert.equal(denied.action, 'clarify')
  assert.deepEqual(denied.added, [])
  assert.deepEqual(denied, await decide('Open WC-999', { ctx: maya }))
  await assert.rejects(decide('Show the timeline', { ctx: maya, input: { scope: claim('WC-103') } }), { status: 404 })
})

test('resolves document and claim titles with sufficient confidence and preserves older document scopes', async () => {
  const question = 'Could you read the Supervisor incident report?'
  assert.deepEqual((await decide(question, { classify: predict('document') })).scope, selected)
  assert.deepEqual((await decide('What does WC-103-report say?')).scope, selected)
  const closed = await decide('Walk me through the Glass shop closure claim.', { classify: predict('claim') })
  assert.deepEqual(closed.scope, claim('WC-114'))
  const old = { kind: 'document', claimIds: ['WC-103'], documentId: 'WC-103-report' }
  assert.deepEqual((await decide('Review WC-103-report', { input: { scope: old } })).scope, old)
  const plus = await decide('Add WC-104', { input: { scope: old } })
  assert.deepEqual(plus.scope, { ...claim('WC-103','WC-104'), documents: selected.documents })
  for (const classifier of [predict('document', .61), predict('document', .94, .23), async () => null]) {
    const response = await decide(question, { classify: classifier })
    assert.equal(response.action, 'clarify')
    assert.deepEqual(response.scope, blank)
  }
})

test('quoted, hypothetical, negated, ambiguous and filesystem mentions preserve the previous selection', async () => {
  for (const question of [
    'Do not attach WC-103.', 'Open WC-103 or WC-104.', 'Compare WC-103 and WC-999.', 'Open WC-103 and WC-101.',
    'Look at “WC-103” as a hypothetical.', 'Use WC-103 as an example.', 'Is WC-103 a valid identifier?',
    'Open ./fixtures/WC-103-report.pdf', 'How is WC-103 referenced in README.md?',
    'Open WC-103 and the North Terminal claim.', 'Bring up the Supervisor incident report and the missing release for WC-103.',
    'Review the mystery report from WC-103.', 'Someone said open WC-103.',
    'Compare the Restricted Shipyard claim to WC-103', 'Open the Restricted claim and WC-103',
    'What does the test suite say about WC-103?',
  ]) {
    const result = await decide(question)
    assert.equal(result.action, 'clarify', question)
    assert.deepEqual(result.added, [], question)
    assert.deepEqual(result.scope, blank, question)
  }
  const duplicate = catalog([...claims, { ...claims.find(c => c.id === 'WC-103'), id: 'WC-115' }])
  assert.equal((await decide('Review Conflicting incident dates', { domain: duplicate })).action, 'clarify')
  const duplicateDocuments = catalog(claims, id => ({ ...getDocument(id), title: 'Shared source report' }))
  assert.equal((await decide('Read Shared source report', { domain: duplicateDocuments, classify: predict('document') })).action, 'clarify')
})

test('manual scopes and exclusions take precedence and mixed workspace writes stay pending', async () => {
  const exclusions = [
    { question: 'Read the Shift handover note', input: { scope: selected } },
    { question: 'Open WC-103-shift', input: { excludedDocumentIds: ['WC-103-shift'] } },
    { question: 'Open WC-103', input: { excludedDocumentIds: ['WC-103-shift'] } },
    { question: 'Open WC-103', input: { excludedClaimIds: ['WC-103'] } },
    { question: 'Show my claims for today', input: { scope: selected } },
  ]
  for (const { question, input } of exclusions) {
    const result = await decide(question, { input, classify: predict('document') })
    assert.equal(result.action, 'clarify', question)
    assert.deepEqual(result.scope, input.scope || blank)
  }
  const reminder = await decide('Why do these dates conflict?', { input: { scope: selected } })
  assert.deepEqual(reminder.scope, selected)
  const mixed = await decide('Read WC-103 and save the result to report.md')
  assert.equal(mixed.mixed, true)
  assert.deepEqual(mixed.added, [])
  assert.deepEqual(mixed.scope, blank)
  assert.equal((await decide('Summarize README.md', { classify: async () => null })).action, 'workspace')
  assert.equal((await decide('Write some JavaScript', { classify: async () => null })).action, 'workspace')
  for (const question of ['What are my open cases?', 'How many open claims do I have?',
    'List all claims across adjusters.', 'Show all the closed cases.',
    'What are total billings for denied claims?', 'What are total billings for Aisha Khan’s open commercial auto claims?']) {
    const result = await decide(question, { classify: async () => null })
    assert.equal(result.action, 'claims')
    assert.deepEqual(result.scope, { kind: 'portfolio' })
  }
  assert.deepEqual((await decide('Which assigned claims have deadlines later today?')).scope, { kind: 'portfolio' })
})

test('decision corrections are scoped to the authenticated employee and one trace, with no prompt content in annotations', async t => {
  const previous = process.env.CLAIMS_ROUTER_URL
  delete process.env.CLAIMS_ROUTER_URL
  t.after(() => { if (previous !== undefined) process.env.CLAIMS_ROUTER_URL = previous })
  const spans = [], fields = []
  const trace = { async run(name, callback, owner) {
    spans.push({ name, owner })
    return callback('trace-id', 'span-id', undefined, data => fields.push(data))
  } }
  const response = await routeClaimsPrompt({ ctx: alex, domain, trace, input: { question: 'Open WC-103', scope: blank } })
  assert.match(response.routingId, /^[\da-f-]{36}$/)
  assert.doesNotMatch(JSON.stringify(fields), /WC-103|employee-alex|Open/)
  const input = { undo: response.routingId }
  for (const ctx of [maya, { ...alex, subject: 'different' }, { ...alex, tenantId: 'different' }, alex, alex])
    await routeClaimsPrompt({ ctx, domain, trace, input })
  assert.deepEqual(spans.map(s => s.name), ['routing.decision','routing.undo'])
  assert.deepEqual(spans.at(-1).owner, { traceId: 'trace-id', spanId: 'span-id' })
})
