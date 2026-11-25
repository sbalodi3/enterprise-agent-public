import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

const collector = process.env.CLAIMS_COLLECTOR_URL || 'http://127.0.0.1:4318'
const jaeger = process.env.CLAIMS_JAEGER_URL || 'http://127.0.0.1:16686'
const traceId = randomBytes(16).toString('hex')
const canary = `synthetic-private-canary-${randomBytes(6).toString('hex')}`
const attribute = (key, value = canary) => ({ key, value:
  typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } })
const routing = {
  'routing.intent': 'document', 'routing.model': 'scope-minilm-012345abcdef',
  'routing.confidence': 'high', 'routing.action': 'claims', 'routing.additions': 2,
}
const attributes = values => Object.entries(values).map(([key, value]) => attribute(key, value))
const start = BigInt(Date.now()) * 1000000n
const span = (name, tags = {}) => ({ traceId, spanId: randomBytes(8).toString('hex'), name, kind: 1,
  startTimeUnixNano: String(start), endTimeUnixNano: String(start + 1000000n),
  attributes: [attribute('claim.note'), ...attributes(tags)], traceState: `private=${canary}`,
  status: { code: 2, message: canary },
  events: [{ name: canary, timeUnixNano: String(start), attributes: [attribute('exception.message')] }],
})
const valid = span('claims.routing.decision', routing)
const offline = { 'routing.intent': 'unavailable', 'routing.model': 'offline', 'routing.confidence': 'unavailable',
  'routing.action': 'clarify', 'routing.additions': 0 }
const offlineSpan = span('claims.routing.decision', offline)
const tainted = span('claims.routing.decision', Object.fromEntries(Object.keys(routing).map(key => [key, canary])))
const wrongType = span('claims.routing.decision', { 'routing.additions': '2' })
const negative = span('claims.routing.decision', { 'routing.additions': -1 })
const oversized = span('claims.routing.decision', { 'routing.additions': 1537 })
const assist = span('claims.assist', routing)
const undo = span('claims.routing.undo', routing)
undo.links = [{ traceId, spanId: valid.spanId }]
const expected = [valid, offlineSpan, tainted, wrongType, negative, oversized, assist, undo]
const response = await fetch(`${collector}/v1/traces`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claims-workbench' } }, attribute('claim.patient')] },
    scopeSpans: [{ scope: { name: canary, version: canary, attributes: [attribute('request.body')] }, spans: [...expected, span(canary)] }],
  }] }), signal: AbortSignal.timeout(5000),
})
assert(response.ok, `Collector rejected synthetic trace: ${response.status}`)
const deadline = Date.now() + 10000
let found
while (Date.now() < deadline) {
  const read = await fetch(`${jaeger}/api/traces/${traceId}`, { signal: AbortSignal.timeout(3000) })
  if (read.ok) {
    const payload = await read.json()
    if (payload.data?.length) { found = payload; break }
  }
  await delay(250)
}
assert(found, 'Allowed span did not reach Jaeger')
const spans = found.data[0].spans
assert.equal(spans.length, expected.length, 'Only the approved operations should reach Jaeger')
for (const request of expected) {
  const exported = spans.find(s => s.spanID === request.spanId)
  assert.equal(exported?.operationName, request.name, 'Approved span missing')
  const tags = Object.fromEntries(exported.tags.filter(t => t.key.startsWith('routing.')).map(t => [t.key, t.value]))
  assert.deepEqual(tags, request === valid ? routing : request === offlineSpan ? offline : {},
    'Routing metadata must have an allowed name, value, type and operation')
}
const undoSpan = spans.find(s => s.spanID === undo.spanId)
assert.ok(undoSpan.references.some(link => link.traceID === traceId && link.spanID === valid.spanId), 'Undo must link to its decision')
assert(!JSON.stringify(found).includes(canary), 'Private attribute/event/status/scope canary reached Jaeger')
console.log('Collector verified routing categories, release, count and Undo link. Unknown operations and synthetic private content were excluded.')
