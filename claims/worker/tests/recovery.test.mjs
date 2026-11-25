import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { containerEngine, containerEnvironment } from '../../deploy/container-engine.mjs'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Runtime, DefaultLogger } from '@temporalio/worker'
import { startWorker, submitClient } from '../index.mjs'

const address = process.env.TEMPORAL_ADDRESS
Runtime.install({ logger: new DefaultLogger('ERROR') })

async function eventually(read, predicate) {
  const deadline = Date.now() + 30000
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await delay(100)
  }
  assert.fail(`Timed out waiting for workflow state; last value ${JSON.stringify(value)}`)
}

test('wage waits survive worker restart; duplicated signals and unknown receipts produce one effect', { skip: !address, timeout: 90000 }, async t => {
  const serviceToken = randomUUID()
  const requestId = `test-${randomUUID()}`
  const operationId = `test-op-${randomUUID()}`
  const taskQueue = `claims-test-${randomUUID()}`
  const records = new Map()
  const ledger = new Map()
  let accepted = 0
  let dispatches = 0
  let deliveryAcks = 0
  const errors = []
  const deliveries = [{ deliveryId: 'start-delivery', kind: 'start', requestId, workItemId: 'WC-102', state: 'awaiting-partner' }]
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${serviceToken}`) { res.writeHead(403).end(); return }
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/dispatchable')) { res.end(JSON.stringify({ items: [] })); return }
    if (req.url.endsWith('/wage/pending')) { res.end(JSON.stringify({ items: deliveries })); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    let result
    if (req.url.endsWith('/wage/delivered')) {
      deliveryAcks += 1
      if (deliveryAcks === 1) { res.writeHead(503).end(JSON.stringify({ error: 'simulated lost delivery ACK' })); return }
      assert.equal(input.deliveryId, 'start-delivery')
      deliveries.splice(0)
      result = { ok: true }
    } else if (req.url.endsWith('/wage/start')) {
      result = records.get(input.requestId) ?? { ...input, state: 'awaiting-partner', operationId: null }
      records.set(input.requestId, result)
    } else if (req.url.endsWith('/wage/accept')) {
      assert.equal(input.eventId, 'fixture-event-1')
      accepted += 1
      result = { ...records.get(input.requestId), state: 'awaiting-review' }
      records.set(input.requestId, result)
    } else if (req.url.endsWith('/wage/status')) result = records.get(input.requestId)
    else if (req.url.endsWith('/wage/timeout')) {
      result = { ...records.get(input.requestId), state: 'timed-out' }
      records.set(input.requestId, result)
    } else if (req.url.endsWith('/dispatch')) {
      dispatches += 1
      assert.equal(records.get(requestId).state, 'approved')
      if (!ledger.has(input.operationId)) ledger.set(input.operationId, { receiptId: `receipt-${input.operationId}` })
      result = { operationId: input.operationId, workItemId: 'WC-102', state: 'unknown' }
    } else if (req.url.endsWith('/reconcile')) {
      assert(ledger.has(input.operationId))
      result = { operationId: input.operationId, workItemId: 'WC-102', state: 'confirmed', ...ledger.get(input.operationId) }
    } else { res.writeHead(404).end(); return }
    res.end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const options = { address, taskQueue, workApiUrl: `http://127.0.0.1:${server.address().port}`, serviceToken, dispatchPollMs: 100, onError: error => errors.push(error) }
  let worker = await startWorker(options)
  t.after(async () => { await worker.stop() })
  const client = await submitClient({ address, taskQueue })
  t.after(() => client.close())

  const first = await client.startWage({ requestId, workItemId: 'WC-102', partnerTimeoutMs: 60000, reviewTimeoutMs: 60000 })
  const duplicate = await client.startWage({ requestId, workItemId: 'WC-102' })
  assert.equal(duplicate.workflowId, first.workflowId)
  assert.equal(duplicate.alreadyStarted, true)
  await eventually(() => client.status(first.workflowId), state => state.phase === 'awaiting-partner')
  await eventually(async () => deliveryAcks, count => count === 2)
  assert.equal(errors.length, 1, 'lost outbox ACK must retry delivery, not fail the worker')
  assert.match(errors[0].message, /503/)
  await worker.stop()
  if (process.env.CLAIMS_TEST_RESTART_SERVER === '1') {
    const engine = containerEngine()
    await promisify(execFile)(engine, ['compose', '--env-file', 'claims/deploy/.env', '-f', 'compose.claims.yml', '--profile', 'story', 'restart', 'temporal'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: containerEnvironment(engine),
    })
  }
  await client.signalWageEvidence({ requestId, eventId: 'fixture-event-1' })
  await client.signalWageEvidence({ requestId, eventId: 'fixture-event-1' })
  worker = await startWorker(options)
  await eventually(() => client.status(first.workflowId), state => state.phase === 'awaiting-review')
  assert.equal(accepted, 1)
  assert.equal(ledger.size, 0, 'waiting for review must not write a destination effect')
  records.set(requestId, { ...records.get(requestId), state: 'approved', operationId })
  await client.signalWageReview(requestId)
  await eventually(() => client.status(first.workflowId), state => state.phase === 'awaiting-reconciliation')
  await worker.stop()
  worker = await startWorker(options)
  await eventually(() => client.status(first.workflowId), state => state.phase === 'awaiting-reconciliation')
  assert.equal(dispatches, 1, 'unknown receipt must not cause redispatch on replay')
  await client.reconcileWage(requestId)
  const result = await client.result(first.workflowId)
  assert.equal(result.state, 'confirmed')
  assert.equal(ledger.size, 1)
  assert.equal(dispatches, 1)

  const timeout = await client.startWage({ requestId: `timeout-${randomUUID()}`, workItemId: 'WC-102', partnerTimeoutMs: 150 })
  assert.equal((await client.result(timeout.workflowId)).state, 'timed-out')

  const lateOperationId = `late-${randomUUID()}`
  const expired = await client.submit({ operationId: lateOperationId, reconciliationTimeoutMs: 100 })
  const unresolved = await client.result(expired.workflowId)
  assert.equal(unresolved.state, 'unknown')
  assert.equal(unresolved.requiresReconciliation, true)
  await assert.rejects(client.requestReconciliation(lateOperationId), error => error.name === 'WorkflowNotFoundError')
})
