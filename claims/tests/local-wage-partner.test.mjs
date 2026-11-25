import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { localWagePartner } from '../showcase/partner/local.mjs'
import { wageDisclosure } from '../showcase/data/wage-cases.mjs'

test('the bundled wage fixture stores one task per reviewed operation and makes released evidence recoverable', async t => {
  const db = new DatabaseSync(':memory:')
  let notice
  let reachable = false
  const handle = localWagePartner({
    db, token: 'test-service-token', signingKey: 'test-signing-key', noticeUrl: 'http://localhost/callback',
    async fetchNotice(_url, request) {
      assert.equal(request.headers.authorization, 'Bearer test-service-token')
      notice = JSON.parse(request.body)
      if (!reachable) throw Error('receiver offline')
      return new Response(null, { status: 202 })
    },
  })
  const server = createServer(handle).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    db.close()
  })
  const origin = 'http://127.0.0.1:' + server.address().port
  function request(path, body, token = 'test-service-token') {
    return fetch(origin + '/requests' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }
  const approved = { requestId: 'request-1', operationId: 'operation-1',
    workItemId: 'WC-102', actorId: 'maya', input: wageDisclosure('WC-102', 'maya'), payloadDigest: 'a'.repeat(64) }
  assert.equal((await request('', approved, 'wrong')).status, 401)
  assert.equal((await request('', { ...approved, input: { ...approved.input, state: 'invalid' } })).status, 422)
  const first = await (await request('', approved)).json()
  assert.deepEqual(await (await request('', approved)).json(), first)
  assert.deepEqual(await (await request('/request-1/receipt')).json(), first)
  assert.equal((await request('', { ...approved, requestId: 'request-2' })).status, 409)
  assert.equal((await request('', { ...approved, payloadDigest: 'b'.repeat(64) })).status, 409)
  assert.equal((await (await request('/request-1')).json()).state, 'working')
  const released = await request('/request-1/release', {})
  assert.equal(released.status, 200)
  assert.deepEqual(await released.json(), { released: true, notificationDelivered: false })
  const completed = await (await request('/request-1')).json()
  assert.equal(completed.state, 'completed')
  assert.equal(completed.artifact.data.payPeriods[0].grossEarnings.amount, '1830.00')
  assert.match(completed.signedResponseHash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(notice.eventId, completed.eventId)
  assert.equal(notice.taskId, first.taskId)
  reachable = true
  assert.deepEqual(await (await request('/request-1/release', {})).json(), { released: true, notificationDelivered: true })
  assert.equal((await (await request('/request-1')).json()).signedResponseHash, completed.signedResponseHash)
})
