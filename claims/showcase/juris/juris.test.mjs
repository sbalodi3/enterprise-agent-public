import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import pg from 'pg'
import { initializeJuris, jurisStore, commandFingerprint } from './store.mjs'
import { createJurisServer } from './server.mjs'

const command = {
  operationId: 'demo-op-1',
  claimId: 'WC-102',
  expectedRevision: 1,
  type: 'record_wage_evidence',
  payloadDigest: 'a'.repeat(64),
  payload: {
    requestId: 'wage-request-1',
    artifactDigest: 'b'.repeat(64),
    documentId: 'wage-wage-request-1',
    anchorId: 'period-1',
    quote: 'Evidence from synthetic payroll.',
  },
}

test('destination constrains commands and fingerprints exact reviewed content', () => {
  for (const bad of [
    { ...command, type: 'issue_payment' },
    { ...command, expectedRevision: 0 },
    { ...command, payloadDigest: 'test' },
    { ...command, payload: { ...command.payload, artifactDigest: 'invalid' } },
    { ...command, payload: { ...command.payload, benefitAmount: 1 } },
    { ...command, payload: { ...command.payload, documentId: '../asset' } },
  ]) {
    assert.throws(() => commandFingerprint(bad))
  }
  assert.equal(
    commandFingerprint(command),
    commandFingerprint({
      ...command,
      payload: Object.fromEntries(Object.entries(command.payload).reverse()),
    }),
  )
  assert.notEqual(
    commandFingerprint(command),
    commandFingerprint({ ...command, payload: { ...command.payload, quote: 'Edited text' } }),
  )
  assert.notEqual(
    commandFingerprint(command),
    commandFingerprint({ ...command, payload: { ...command.payload, artifactDigest: 'c'.repeat(64) } }),
  )
})

test(
  'independent JURIS reads, concurrent writes, stale destination revision and lost acknowledgement',
  { skip: !process.env.JURIS_TEST_ADMIN_URL },
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.JURIS_TEST_ADMIN_URL })
    const name = `juris_test_${randomUUID().replaceAll('-', '')}`
    const dbUrl = new URL(process.env.JURIS_TEST_ADMIN_URL)
    dbUrl.pathname = '/' + name
    let db, server
    try {
      await admin.query(`CREATE DATABASE ${name}`)
      db = new pg.Pool({ connectionString: dbUrl.href })
      await initializeJuris(db)
      const store = jurisStore(db)
      const token = randomUUID()
      server = createJurisServer(store, token)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const base = `http://127.0.0.1:${server.address().port}`
      const get = async (path) =>
        (await fetch(base + path, { headers: { authorization: `Bearer ${token}` } })).json()
      const post = async (body) =>
        fetch(base + '/v1/commands', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      assert.equal((await fetch(base + '/v1/claims/WC-102')).status, 401)
      assert.deepEqual(await get('/health'), { status: 'ok' })
      assert.equal((await get('/v1/claims/WC-102')).revision, 1)
      const results = await Promise.all(Array.from({ length: 5 }, () => post(command)))
      assert.ok(results.every((r) => r.status === 200))
      const receipts = await Promise.all(results.map((r) => r.json()))
      assert.equal(new Set(receipts.map((r) => r.receiptId)).size, 1)
      // When the worker misses the POST response, the immutable destination receipt survives.
      assert.deepEqual(await get('/v1/receipts/' + command.operationId), receipts[0])
      assert.equal((await post({ ...command, expectedRevision: 2 })).status, 409)
      const stale = await post({ ...command, operationId: 'op-2' })
      assert.deepEqual(await stale.json(), { error: 'stale_revision' })
      const after = await get('/v1/claims/WC-102')
      assert.equal(after.revision, 2)
      assert.equal(after.receipts.length, 1)
      assert.deepEqual(after.wageEvidence, command.payload)
      const intake = {
        ...command,
        operationId: 'op-3',
        claimId: 'WC-105',
        type: 'file_intake_transcript',
        payload: {
          intakeId: 'IN-201',
          documentId: 'IN-201-call',
          anchorId: 'worksite',
          quote: 'My incident was at Cedar Dock, loading bay three.',
        },
      }
      assert.equal((await post(intake)).status, 200)
      assert.equal((await post({ ...intake, operationId: 'op-4', claimId: 'WC-107' })).status, 409)
      assert.deepEqual((await get('/v1/claims/WC-107')).intakeTranscripts, [])
      // Starting the service again must preserve both effects.
      await initializeJuris(db)
      assert.equal((await get('/v1/claims/WC-105')).revision, 2)
      assert.deepEqual((await get('/v1/claims/WC-105')).intakeTranscripts, [intake.payload])
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve))
      if (db) {
        await db.end()
        await admin.query(`DROP DATABASE ${name}`)
      }
      await admin.end()
    }
  },
)
