import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import { createHandoffClient } from '../portfolios/a2a-client.mjs'
import { createLegalPeer } from '../portfolios/a2a-server.mjs'
import { cardPath, contextId, requestData, taskId } from '../portfolios/a2a-contract.mjs'

const token = 'synthetic-finance-credential'
const reviewToken = 'synthetic-legal-credential'
const row = {
  id: 'HO-' + randomUUID(),
  state: 'queued',
  financeId: 'FIN-207',
  matterId: 'MAT-017',
  invoiceRef: 'INV-318',
  expenseRef: 'EXP-044',
  amountCents: 60000,
}
const approved = { disposition: 'no_amendment', reference: 'AUTH-600-01' }
const sent = {
  kind: 'message',
  messageId: row.id,
  role: 'user',
  parts: [{ kind: 'data', data: requestData(row) }],
}
function runPeer(path) {
  // Card origin may be computed lazily because listen assigns the ephemeral port.
  let origin
  const peer = createLegalPeer({ path, token, reviewToken, origin: { toString: () => origin } })
  return (async () => {
    peer.listen(0, '127.0.0.1')
    await once(peer, 'listening')
    origin = 'http://127.0.0.1:' + peer.address().port
    async function rpc(method, params, key = token) {
      const response = await fetch(origin + '/a2a', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      })
      return response.json()
    }
    return { origin, rpc, stop: () => new Promise((resolve) => peer.close(resolve)) }
  })()
}

test('finance and legal handoff survives lost acknowledgements, peer restart, and duplicate delivery', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'department-a2a-'))
  const path = join(dir, 'legal.sqlite')
  let peer = await runPeer(path)
  t.after(async () => {
    await peer.stop()
    await rm(dir, { recursive: true, force: true })
  })
  const receiptLog = new Map()
  const inbox = new Set()
  let failAfterReceipt = true
  const store = {
    async noteHandoffSent(id) {
      inbox.add(id)
    },
    async finishHandoff(id, artifact) {
      if (failAfterReceipt) {
        failAfterReceipt = false
        throw Error('database unavailable')
      }
      receiptLog.set(id, artifact)
    },
  }
  let send = createHandoffClient({ url: peer.origin, token, reviewToken })
  await Promise.all([send(store, row), send(store, row)])
  assert.deepEqual([...inbox], [row.id])
  const pending = await peer.rpc('tasks/get', { id: taskId(row.id) })
  assert.equal(pending.result.status.state, 'working')
  assert.equal(pending.result.artifacts, undefined)
  const reviewed = { ...row, state: 'reply_queued', ...approved }
  await assert.rejects(send(store, reviewed), /database unavailable/)
  await peer.stop()
  peer = await runPeer(path)
  send = createHandoffClient({ url: peer.origin, token, reviewToken })
  await send(store, reviewed)
  assert.deepEqual([...receiptLog], [[row.id, approved]])
  const authoritative = await peer.rpc('tasks/get', { id: taskId(row.id) })
  assert.equal(authoritative.result.status.state, 'completed')
  assert.deepEqual(authoritative.result.artifacts[0].parts[0].data, approved)
})

test('peer enforces caller roles, task binding and approved fields', async (t) => {
  const peer = await runPeer(':memory:')
  t.after(peer.stop)
  assert.equal((await fetch(peer.origin + cardPath)).status, 401)
  const good = await peer.rpc('message/send', { message: sent })
  assert.equal(good.result.id, taskId(row.id))
  const withData = (data) => ({ message: { ...sent, parts: [{ kind: 'data', data }] } })
  const extra = await peer.rpc('message/send', withData({ ...requestData(row), privateNote: 'test' }))
  assert.equal(extra.error.code, -32602)
  const wrong = await peer.rpc('message/send', withData({ ...requestData(row), matterId: 'MAT-018' }))
  assert.equal(wrong.error.code, -32602)
  const reply = {
    message: {
      ...sent,
      messageId: 'review-' + row.id,
      contextId: contextId(row.id),
      taskId: taskId(row.id),
      parts: [{ kind: 'data', data: approved }],
    },
  }
  assert.equal((await peer.rpc('message/send', reply, token)).error.code, -32602)
  assert.equal(
    (await peer.rpc('message/send', { message: { ...reply.message, contextId: 'unrelated' } }, reviewToken))
      .error.code,
    -32602,
  )
  assert.equal((await peer.rpc('tasks/get', { id: taskId(row.id) })).result.status.state, 'working')
})

test('mismatched remote task or extra disclosure can never create a finance receipt', async () => {
  const { card } = await import('../portfolios/a2a-contract.mjs')
  const origin = 'http://127.0.0.1:3092'
  let mismatch = true
  const fetchFn = async (url, init) => {
    if (url.endsWith(cardPath)) return Response.json(card(origin))
    const rpc = JSON.parse(init.body)
    const result = {
      kind: 'task',
      id: taskId(row.id),
      contextId: contextId(row.id),
      status: { state: 'completed' },
    }
    if (rpc.method === 'tasks/get') {
      result.artifacts = [
        {
          artifactId: 'review-' + row.id,
          parts: [{ kind: 'data', data: { ...approved, extraField: 'internal' } }],
        },
      ]
      if (mismatch) result.id = 'another-task'
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result })
  }
  const send = createHandoffClient({ url: origin, token, reviewToken, fetchFn })
  let delivered = false
  const store = {
    async finishHandoff() {
      delivered = true
    },
  }
  await assert.rejects(send(store, { ...row, state: 'reply_queued', ...approved }), /Unverified Legal task/)
  mismatch = false
  await assert.rejects(
    send(store, { ...row, state: 'reply_queued', ...approved }),
    /Unverified Legal receipt/,
  )
  assert.equal(delivered, false)
})
