import test from 'node:test'
import assert from 'node:assert/strict'
import { studyCases } from '../showcase/wage-study/cases.mjs'
import { buildWageDocument, getDocument } from '../showcase/data/documents.mjs'
import { createClaimReads } from '../runtime/chat-mcp.mjs'
import { verifiedChatAnswer } from '../runtime/claim-chat.mjs'
import { wageCoverage } from '../domain/wage-coverage.mjs'

function turn(record, scope = {kind:'claim', claimIds:[record.id]}, options = {}) {
  const domain = {chatEvidenceIndex: async () => ({item:{version:2}, documents:record.records}),
    chatSource: async (_, ref) => record.records.find(d => d.id === ref.documentId)}
  return createClaimReads({domain, principal:{}, allowed:['review_wage_evidence'], scope,
    signal:new AbortController().signal, reauthorize: async () => {}, wagePilot:true, ...options})
}
test('matched synthetic cases preserve cited coverage, overlapping days, and competing accounts', async () => {
  for (const [i, record] of studyCases.entries()) {
    const reads = turn(record)
    const { structuredContent } = await reads.call('review_wage_evidence', {})
    const order = structuredContent.facts.map(f => f.id).reverse()
    const state = reads.state()
    const answer = verifiedChatAnswer({kind:'claim', claimIds:[record.id]}, 'Review wage evidence', JSON.stringify({order}), state)
    assert.equal(answer.wageReview.layout, 'model')
    const components = answer.wageReview.messages[1].updateComponents.components
    assert.deepEqual(components.filter(c => !['Column','SourceLink'].includes(c.component)).map(c => c.id), order)
    const days = [0,7,21,21][Math.floor(i/2)]
    assert.ok(answer.text.includes(days + ' of 21 requested days'))
    assert.equal(answer.text.includes('Sources give different'), i >= 6)
    const gap = state.wageReview.facts.find(f => f.component === 'Gap')
    assert.equal(Boolean(gap), i < 4)
    if (gap) assert.equal(gap.refs.length, record.records.length)
    for (const source of answer.sources) {
      assert.equal(source.claimVersion, 2)
      assert.ok(record.records.find(d => d.id === source.documentId && d.version === source.documentVersion)?.anchors.some(a => a.id === source.anchorId))
    }
    const invalid = verifiedChatAnswer({kind:'claim',claimIds:[record.id]}, 'Review payroll', '{"order":["unverified"]}', state)
    assert.equal(invalid.wageReview.layout, 'fixed')
  }
})
test('historical missing attachment and later partial wage return have separate citations', async () => {
  const claim = {id:'WC-102', records:[getDocument('WC-102-report')]}
  const before = turn(claim)
  await before.call('review_wage_evidence', {})
  assert.match(before.state().wageReview.facts[0].text, /accompanied the report/)
  claim.records.push(buildWageDocument(claim.id, {requestId:'unit', artifact:{data:{
    payPeriods:[{periodStart:'2026-06-01',periodEnd:'2026-06-14'}]},
    provenance:{recordIds:['unit'],sourceSystem:'Test',asOf:'2026-06-15'}}}))
  const after = turn(claim)
  await after.call('review_wage_evidence', {})
  const { facts } = after.state().wageReview
  assert.ok(facts.some(f => f.text.includes('14 of 364')))
  assert.equal(facts.filter(f => f.text.startsWith('No returned period')).length, 2)
})
test('only a whole-claim pilot read can expose wage review; access loss rejects its result', async () => {
  const record = studyCases[2]
  for (const scope of [{kind:'portfolio'},{kind:'document',claimIds:[record.id],documentId:'request'},
    {kind:'claim',claimIds:[record.id],documents:{[record.id]:['request']}},{kind:'multi',claimIds:[record.id,'WC-102']}]) {
    const reads = turn(record, scope)
    assert.equal(reads.tools.length, 0)
    assert.match(verifiedChatAnswer(scope,'Review wage coverage','',reads.state()).text,/one whole claim/)
  }
  assert.equal(turn(record, undefined, {wagePilot:false}).tools.length, 0)
  let count = 0
  const reads = turn(record, undefined, {reauthorize:async () => { if (++count === 2) throw Error('revoked') }})
  await assert.rejects(reads.call('review_wage_evidence', {}), /revoked/)
})
test('equivalent amounts and unavailable hours are compatible accounts', async () => {
  const record = structuredClone(studyCases[6])
  record.records[2].anchors[0].text = record.records[1].anchors[0].text.replace('1800.', '1800.00.').replace('Regular hours: unavailable.', 'Regular hours: 80.')
  const reads = turn(record)
  await reads.call('review_wage_evidence', {})
  assert.ok(!reads.state().wageReview.facts.some(f => f.component === 'Disagreement'))
})
test('unitemized or inconsistent returns prevent a definitive gap calculation', async () => {
  const record = structuredClone(studyCases[2])
  const statement = record.records[1]
  statement.anchors.push({id:'coverage', label:'Coverage', text:'Requested 2026-03-01 through 2026-03-21. Returned payroll records cover 14 of 21 requested days.'})
  const reads = turn(record)
  await reads.call('review_wage_evidence', {})
  const { facts } = reads.state().wageReview
  assert.ok(facts.some(f => f.component === 'Disagreement' && f.refs.length === 2))
  assert.ok(!facts.some(f => f.text.startsWith('No returned period')))
  statement.anchors = [{id:'note',label:'Payroll',text:'Itemized details pending.'}]
  const unknown = turn(record)
  await unknown.call('review_wage_evidence', {})
  assert.ok(!unknown.state().wageReview.facts.some(f => f.text.includes('requested days documented')))
})
test('calendar interval projection clips out-of-window records and rejects impossible dates', () => {
  const period = {periodStart:'2026-02-25',periodEnd:'2026-03-03'}
  assert.deepEqual(wageCoverage([period,period],'2026-03-01','2026-03-04'),
    {requested:4,days:3,covered:[['2026-03-01','2026-03-03']],gaps:[['2026-03-04','2026-03-04']]})
  assert.throws(() => wageCoverage([], '2026-02-31', '2026-03-10'), RangeError)
})
