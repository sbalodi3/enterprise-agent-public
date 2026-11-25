import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationApi } from '../runtime/conversation-api.mjs'
import { DomainError } from '../domain/index.mjs'

const id = '00000000-0000-4000-8000-000000000001'
const req = { method: 'GET' }
const query = new URLSearchParams({ claimId: 'WC-103', claimVersion: '1', documentId: 'WC-103-shift',
  documentVersion: '1', anchorId: 'date', format: 'pdf' })

test('logout during the protected source read prevents PDF delivery', async () => {
  let live = true
  const auth = { require() { if (!live) throw new DomainError(401, 'AUTH_REQUIRED') } }
  const domain = { citedChatSource: async () => { live = false; return {} } }
  const api = createConversationApi({ auth, domain, runTurn: true })
  await assert.rejects(api(req, { writeHead: () => assert.fail('source published after logout') }, {}, 'source/' + id, {}, query),
    { status: 401, code: 'AUTH_REQUIRED' })
})

test('conversation lookup distinguishes stale saved evidence from unavailable sources', async () => {
  const auth = { require: () => ({}) }
  const domain = { citedChatSource: async () => { throw new DomainError(409, 'stale_version') } }
  const api = createConversationApi({ auth, domain, runTurn: true })
  await assert.rejects(api(req, {}, {}, 'source/' + id, {}, query), { status: 409, code: 'stale_version' })
})

test('scope picker dispatches employee identity, lifecycle filter, pagination, revision and independent session creation', async () => {
  const employee = { principalId: 'maya' }, selection = { kind: 'claim', claimIds: ['WC-101'] }
  const observed = []
  const domain = Object.fromEntries(['chatSearch','chatDocuments','openConversation','updateChatScope'].map(name =>
    [name, (...args) => { observed.push([name, ...args]); return { items: [], total: 0 } }]))
  const api = createConversationApi({ domain, auth: {}, runTurn: true })
  const post = { method: 'POST' }, params = new URLSearchParams({ q:'closing',status:'closed',offset:'3',limit:'8' })
  await api(req, {}, employee, 'search', {}, params)
  await api(req, {}, employee, 'documents/WC-101', {}, params)
  await api(post, {}, employee, 'conversations', { scope: selection, fresh: true }, params)
  await api(post, {}, employee, 'scope/' + id, { scope: selection, expectedRevision: 2 }, params)
  assert.deepEqual(observed, [
    ['chatSearch', employee, { query: 'closing', status: 'closed', offset: 3, limit: 8 }],
    ['chatDocuments', employee, 'WC-101'],
    ['openConversation', employee, selection, { fresh: true }],
    ['updateChatScope', employee, id, selection, 2],
  ])
  await assert.rejects(api(post, {}, employee, 'documents/WC-101', {}, params), { status: 404 })
})
