import test from 'node:test'
import assert from 'node:assert/strict'
import { timelineRpc } from '../timeline.mjs'

test('the app advertises one read-only tool, preserves event citations and rejects an outdated claim revision', async () => {
  const user = { principalId: 'maya' }
  const reads = []
  const domain = {
    async detail(ctx, id) {
      reads.push([ctx.principalId, id])
      if (id !== 'WC-102') throw Error('not_found')
      return {
        item: { id, version: 3 },
        timeline: [
          {
            at: '2026-11-17',
            summary: 'Wage returned',
            source: 'Partner',
            evidenceId: 'wage',
            anchorId: 'period-1',
            documentVersion: 2,
          },
        ],
        showcase: {
          documents: [
            {
              id: 'wage',
              asOf: '2026-11-16',
              version: 2,
              title: 'Wage statement',
              anchors: [{ id: 'coverage' }, { id: 'period-1' }],
            },
          ],
        },
      }
    },
  }
  const call = (method, params = {}, id = 'WC-102') =>
    timelineRpc(domain, user, id, { jsonrpc: '2.0', id: 1, method, params })
  const {
    result: { tools },
  } = await call('tools/list')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].annotations.readOnlyHint, true)
  const uri = tools[0]._meta.ui.resourceUri
  assert.equal(
    (await call('resources/read', { uri })).result.contents[0].mimeType,
    'text/html;profile=mcp-app',
  )
  assert.equal((await call('resources/read', { uri: 'ui://other/test' })).error.code, -32602)
  const params = { name: tools[0].name, arguments: { expectedVersion: 3 } }
  const result = (await call('tools/call', params)).result
  assert.equal(result.structuredContent.events[0].document, 'wage')
  assert.equal(result.structuredContent.events[0].anchorId, 'period-1')
  assert.match(result.content[0].text, /Wage returned/)
  await assert.rejects(call('tools/call', { ...params, arguments: { expectedVersion: 2 } }), /stale_version/)
  await assert.rejects(call('tools/call', params, 'WC-103'), /not_found/)
  assert.ok(reads.every(([id]) => id === 'maya'))
})
