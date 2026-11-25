import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { telemetry } from '../runtime/telemetry.mjs'
test('trace links survive asynchronous dispatch and omit error text and business data', async () => {
  const exporter = new InMemorySpanExporter()
  const tracer = telemetry(null, exporter)
  let predecessor
  await tracer.run('review', async (traceId, spanId) => {
    predecessor = { traceId, spanId }
    await tracer.run('policy', async () => {})
  })
  const marker = 'SYNTHETIC-PRIVATE-EXCERPT'
  await assert.rejects(
    tracer.run(
      'worker.dispatch',
      () => {
        throw new Error(marker)
      },
      predecessor,
    ),
  )
  const spans = exporter.getFinishedSpans()
  assert.equal(spans[0].parentSpanId, predecessor.spanId)
  assert.equal(spans[2].links[0].context.traceId, predecessor.traceId)
  assert.equal(spans[2].resource.attributes['service.name'], 'claims-workbench')
  assert.ok(!JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events, s.status])).includes(marker))
  await tracer.close()
})

test('routing spans export categorical attributes and discard unrecognized fields and values', async () => {
  const exporter = new InMemorySpanExporter()
  const tracer = telemetry(null, exporter)
  await tracer.run('routing.decision', (traceId, spanId, link, annotate) => annotate({
    'routing.action': 'claims', 'routing.intent': 'document', 'routing.confidence': 'private excerpt',
    'routing.model': 'scope-minilm-123456abcdef', 'routing.additions': 1, question: 'private excerpt',
  }))
  assert.deepEqual(exporter.getFinishedSpans()[0].attributes, {
    'routing.action': 'claims', 'routing.intent': 'document', 'routing.model': 'scope-minilm-123456abcdef', 'routing.additions': 1,
  })
  await tracer.close()
})
