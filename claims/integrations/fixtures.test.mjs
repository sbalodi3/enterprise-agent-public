import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createFixtureIngress } from './fixtures.mjs'
import { createDomain, migrate, seed } from '../domain/index.mjs'

const token = randomBytes(32).toString('hex'), workerToken = randomBytes(32).toString('hex')
async function serve(t, domain) {
  const server = createServer(createFixtureIngress({ domain, token, workerToken }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return async (body, credential = token, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/claims/integrations/fixtures`, {
      method: options.method || 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
      ...(options.method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
}
test('fixture ingress requires its separate service token and accepts only a predefined envelope', async t => {
  const calls = []
  const domain = { fixture: async (...args) => { calls.push(args); return { duplicate: false } } }
  assert.throws(() => createFixtureIngress({ domain, token: workerToken, workerToken }), /must differ/)
  assert.throws(() => createFixtureIngress({ domain, token: '' }), /dedicated/)
  const post = await serve(t, domain), body = { source: 'voice-intake', eventId: 'voice-1' }
  for (const credential of [null, 'forged', workerToken]) assert.equal((await post(body, credential)).status, 403)
  assert.equal((await post(body, token, { method: 'GET' })).status, 405)
  for (const invalid of [
    { ...body, itemId: 'WC-103' }, { ...body, tenantId: 'isolation' }, { ...body, profileId: 'legal-test-v1' },
    { ...body, principalId: 'supervisor' }, { ...body, source: 'unknown' }, { ...body, source: '__proto__' },
    { ...body, eventId: '' }, { ...body, eventId: '../other' }, [], 'invalid-json',
  ]) assert.equal((await post(invalid)).status, 400)
  assert.equal((await post('x'.repeat(2049))).status, 413)
  assert.equal(calls.length, 0)
  assert.equal((await post(body)).status, 200)
  assert.deepEqual(calls, [[{
    principalId: 'fixture-ingress', subject: 'service:fixture-ingress:voice-intake', tenantId: 'demo', profileId: 'claims-v1',
  }, { fixtureId: 'voice-intake', eventId: 'voice-1' }]])
})

test('service delivery survives a browser being absent and duplicate replay survives handler restart', {
  skip: !process.env.CLAIMS_TEST_DATABASE_URL,
}, async t => {
  const schema = 'cw_ingress_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: process.env.CLAIMS_TEST_DATABASE_URL })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: process.env.CLAIMS_TEST_DATABASE_URL, options: '-c search_path=' + schema })
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await migrate(pool)
  await seed(pool)
  const domain = createDomain(pool)
  const post = await serve(t, domain)
  const body = { source: 'voice-intake', eventId: 'external-stable-event' }
  // No cookie, browser, or user session exists in this test.
  const replies = await Promise.all([post(body), post(body)])
  assert.deepEqual(replies.map(value => value.status), [200, 200])
  assert.equal(replies.filter(value => value.body.duplicate).length, 1)
  const restarted = await serve(t, createDomain(pool))
  assert.equal((await restarted(body)).body.duplicate, true)
  assert.equal((await restarted({ ...body, source: 'calendar-change' })).status, 409)
  const maya = { principalId: 'maya', subject: 'verified-maya', tenantId: 'demo', profileId: 'claims-v1' }
  const detail = await domain.detail(maya, 'IN-201')
  assert.equal(detail.item.version, 2)
  assert.equal(detail.timeline.filter(event => event.kind === 'intake.received').length, 1)
  const inbox = await domain.mailbox(maya)
  assert.equal(inbox.items.filter(item => item.itemId === 'IN-201' && item.source === 'Voice intake').length, 1)
  const receivedEvent = await pool.query("SELECT actor,subject_id FROM cw_events WHERE item_id='IN-201' AND kind='intake.received'")
  assert.deepEqual(receivedEvent.rows, [{ actor: 'fixture-ingress', subject_id: 'service:fixture-ingress:voice-intake' }])
  const created = await post({ source: 'voice-team-intake', eventId: 'new-team-intake' })
  assert.equal(created.status, 200)
  assert.equal(created.body.itemId, 'IN-202')
  const team = await domain.detail(maya, 'IN-202')
  assert.equal(team.item.ownerId, 'claims-intake')
  assert.equal((await post({ source: 'voice-team-intake', eventId: 'new-team-intake' })).body.duplicate, true)
})
