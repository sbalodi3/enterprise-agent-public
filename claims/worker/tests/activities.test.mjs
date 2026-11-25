import test from 'node:test'
import assert from 'node:assert/strict'
import { createActivities } from '../activities.mjs'

test('authenticated retries preserve operation identity and unknown results', async () => {
  const calls = []
  const activities = createActivities({ workApiUrl: 'http://work-api:3080', serviceToken: 'test-service-token',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.href, ...options })
      return new Response(JSON.stringify({ operationId: 'op-1', workItemId: 'WC-102', state: 'unknown' }), { status: 200 })
    },
  })
  const first = await activities.dispatchOperation({ operationId: 'op-1' })
  const second = await activities.dispatchOperation({ operationId: 'op-1' })
  assert.equal(first.state, 'unknown')
  assert.equal(second.state, 'unknown')
  assert.equal(calls[0].headers.authorization, 'Bearer test-service-token')
  assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key'])
  assert.equal(calls[0].url, 'http://work-api:3080/api/internal/work/dispatch')
  assert.equal(calls.length, 2)
})

test('access rejection is not retried and response body is not copied into failure', async () => {
  const activities = createActivities({ workApiUrl: 'http://localhost', serviceToken: 'test',
    fetchImpl: async () => new Response('private claim body', { status: 403 }),
  })
  await assert.rejects(activities.dispatchOperation({ operationId: 'op-1' }), error => {
    assert.equal(error.nonRetryable, true)
    assert.equal(error.type, 'WorkApiRejected')
    assert.equal(error.message.includes('private claim body'), false)
    return true
  })
})

test('transient failure may retry but malformed successful envelopes do not', async () => {
  const base = { workApiUrl: 'http://localhost', serviceToken: 'test' }
  await assert.rejects(createActivities({ ...base, fetchImpl: async () => new Response('', { status: 503 }) }).wageStatus({ requestId: 'req' }), error => error.nonRetryable === false)
  await assert.rejects(createActivities({ ...base, fetchImpl: async () => new Response('{}') }).wageStatus({ requestId: 'req' }), error => error.type === 'WorkApiContract')
})
