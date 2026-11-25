import { AsyncLocalStorage } from 'node:async_hooks'
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from '@opentelemetry/api'
import { Resource } from '@opentelemetry/resources'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

const routingTags = {
  'routing.intent': new Set(['workspace', 'claim', 'document', 'portfolio', 'clarify', 'unavailable']),
  'routing.confidence': new Set(['high', 'low', 'unavailable']),
  'routing.action': new Set(['claims', 'workspace', 'clarify']),
}

function recordRouting(span, attributes) {
  for (const [key, choices] of Object.entries(routingTags)) {
    if (choices.has(attributes[key])) span.setAttribute(key, attributes[key])
  }
  const version = attributes['routing.model']
  if (version === 'offline' || /^scope-minilm-[0-9a-f]{12}$/.test(version)) span.setAttribute('routing.model', version)
  const additions = attributes['routing.additions']
  if (Number.isSafeInteger(additions) && additions >= 0 && additions <= 1536) span.setAttribute('routing.additions', additions)
}

// Keep business payloads in authorized data stores. Export only static operation
// names, approved routing categories, release metadata and opaque identifiers.
export function telemetry(endpoint, exporter) {
  const provider = new BasicTracerProvider({
    resource: new Resource({ 'service.name': 'claims-workbench', 'service.version': '1.0.0' }),
  })
  if (endpoint || exporter) {
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter ?? new OTLPTraceExporter({ url: endpoint })))
  }
  const tracer = provider.getTracer('claims-workbench', '1.0.0')
  const active = new AsyncLocalStorage()
  return {
    async run(name, action, predecessor) {
      const links =
        predecessor?.traceId && predecessor?.spanId
          ? [{ context: { ...predecessor, traceFlags: TraceFlags.SAMPLED, isRemote: true } }]
          : []
      const parent = active.getStore() ?? ROOT_CONTEXT
      const span = tracer.startSpan('claims.' + name, { links }, parent)
      const { traceId, spanId } = span.spanContext()
      try {
        return await active.run(trace.setSpan(parent, span), () =>
          action(traceId, spanId, (anchor) => {
            if (anchor?.traceId && anchor?.spanId)
              span.addLink({ context: { ...anchor, traceFlags: TraceFlags.SAMPLED, isRemote: true } })
          }, (attributes) => { if (name === 'routing.decision') recordRouting(span, attributes) }),
        )
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw error
      } finally {
        span.end()
      }
    },
    close: () => provider.shutdown(),
  }
}
