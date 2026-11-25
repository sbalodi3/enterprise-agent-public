// Exercise the staged classifier and production resolver on unseen synthetic requests.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decideScope } from '../runtime/scope-router.mjs'
import { selectedDocumentIds } from '../domain/chat.mjs'

if (!process.env.CLAIMS_ROUTER_URL) throw Error('Set CLAIMS_ROUTER_URL to the staged CPU service.')
const fixtures = (await readFile(new URL('./heldout.jsonl', import.meta.url), 'utf8'))
  .trim().split('\n').map(line => JSON.parse(line))
const claims = [...new Set(fixtures.flatMap(row => row.claimIds || []).concat(['WC-987', 'WC-112', 'WC-981', 'WC-844']))]
  .map(id => ({ id, title: id === 'WC-700' ? 'Conflicting incident dates' : 'Synthetic record ' + id }))
const documents = [
  ['WC-857-note', 'Shift handover note'], ['WC-807-report', 'Employer incident report'],
  ['WC-687-wage', 'Partner wage statement'], ['WC-904-report', 'Employer incident report'],
  ['WC-901-supervisor', 'Supervisor incident report'],
]
const domain = {
  async assertChatScope() {},
  async chatSearch(ctx, { offset, limit }) { return { items: claims.slice(offset, offset + limit), total: claims.length } },
  async chatDocuments(ctx, claimId) {
    return { items: documents.filter(([id]) => id.startsWith(claimId + '-')).map(([id,title]) => ({ id, title })) }
  },
}
let correctIntents = 0, positives = 0, correctScopes = 0, falseAdds = 0
const failures = []
let version
for (const row of fixtures) {
  const result = await decideScope({ domain, ctx: {}, input: { question: row.text, scope: { kind: 'workspace' } } })
  assert.match(result.version, /^scope-minilm-[a-f0-9]{12}$/)
  if (version) assert.equal(version, result.version)
  version = result.version
  if (result.intent === row.label) correctIntents++
  if (row.claimIds) {
    positives++
    const idsMatch = JSON.stringify(result.scope.claimIds) === JSON.stringify(row.claimIds)
    const docs = selectedDocumentIds(result.scope, row.claimIds[0])
    if (result.action === 'claims' && idsMatch && (row.documentId ? docs?.length === 1 && docs[0] === row.documentId : !docs)) correctScopes++
    else failures.push(row.text)
  } else {
    if (result.added.length || result.scope.claimIds?.length) falseAdds++
    if (row.label === 'portfolio') assert.equal(result.scope.kind, 'portfolio', row.text)
    if (row.label === 'workspace') assert.equal(result.action, 'workspace', row.text)
  }
}
// These realistic requests test access and ambiguity even if classified as a clear document or claim intent.
for (const question of ['Open WC-990.', 'Show the Employer incident report.', 'Read WC-807 or WC-901.', 'Compare WC-807 with WC-990.']) {
  const result = await decideScope({ domain, ctx: {}, input: { question, scope: { kind: 'workspace' } } })
  if (result.added.length || result.scope.kind !== 'workspace') falseAdds++
}
console.log(JSON.stringify({ version, intentAccuracy: correctIntents + '/' + fixtures.length,
  exactSelections: correctScopes + '/' + positives, falseAdds, missedSyntheticRequests: failures }, null, 2))
assert.ok(correctScopes / positives >= 0.9, 'Clear selection accuracy below 90%')
assert.equal(falseAdds, 0, 'Unexpected automatic attachment')
