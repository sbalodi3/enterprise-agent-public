import { widgetResources } from '../runtime/widget-resources.mjs'
import { DomainError } from '../domain/index.mjs'

const uri = 'ui://enterprise-agent/claim-timeline.html'
const mimeType = 'text/html;profile=mcp-app'
const widget = widgetResources.get('claim-timeline')
const tool = {
  name: 'claim_timeline',
  description: 'Read the selected claim timeline with its source references.',
  inputSchema: {
    type: 'object',
    properties: { expectedVersion: { type: 'integer' } },
    required: ['expectedVersion'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri: uri } },
}
const resource = { uri, name: 'Claim timeline', mimeType }
export function timelineSources(documents) {
  return documents.map(d => ({ id: d.id, title: d.title, at: d.asOf, anchorId: d.anchors[0]?.id }))
}
export async function timelineRpc(domain, ctx, itemId, rpc, scopedDocuments) {
  const error = (code, message) => ({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code, message } })
  if (rpc.jsonrpc !== '2.0' || !['number', 'string'].includes(typeof rpc.id))
    return error(-32600, 'Invalid request')
  const detail = await domain.detail(ctx, itemId)
  let result
  switch (rpc.method) {
    case 'initialize':
      result = {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'enterprise-agent-timeline', version: '1.0.0' },
        capabilities: { tools: {}, resources: {} },
      }
      break
    case 'tools/list':
      result = { tools: [tool] }
      break
    case 'resources/list':
      result = { resources: [resource] }
      break
    case 'resources/read':
      if (rpc.params?.uri !== uri) return error(-32602, 'Unknown resource')
      result = {
        contents: [
          widget,
        ],
      }
      break
    case 'tools/call': {
      if (rpc.params?.name !== tool.name) return error(-32602, 'Unknown tool')
      if (rpc.params.arguments?.expectedVersion !== detail.item.version)
        throw new DomainError(409, 'stale_version')
      const documents = scopedDocuments ?? detail.showcase.documents
      const sources = timelineSources(documents)
      const events = detail.timeline
        .filter(
          (e) =>
            !(
              e.kind === 'document.received' &&
              sources.some((d) => d.id === e.evidenceId && d.at === e.at && d.title === e.summary)
            ),
        )
        .map((e) => {
          const source = documents.find(
            (d) => d.id === e.evidenceId && d.version === e.documentVersion,
          )
          const anchor = source?.anchors.find((a) => a.id === e.anchorId) || source?.anchors[0]
          return {
            at: ['claim.loss-date','claim.report-date'].includes(e.kind) ? e.at.slice(0, 10) : e.at,
            ...(['claim.loss-date','claim.report-date'].includes(e.kind) && { dateOnly: true }),
            title: e.summary,
            source: e.source,
            ...(anchor && { document: source.id, anchorId: anchor.id }),
          }
        })
      const text = [
        ...events.map((e) => e.at + ' · ' + e.title),
        ...sources.map((d) => d.at + ' · ' + d.title),
      ]
        .sort()
        .join('\n')
      result = { content: [{ type: 'text', text }], structuredContent: { itemId, events, sources } }
      break
    }
    default:
      return error(-32601, 'Method not found')
  }
  return { jsonrpc: '2.0', id: rpc.id, result }
}
