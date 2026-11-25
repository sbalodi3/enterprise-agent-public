import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { migrate, seed, createDomain } from '../domain/index.mjs'
import { startLocalDispatchRecovery } from '../runtime/plugin.mjs'

test(
  'default host recovers committed approvals and preserves unknown receipts',
  {
    skip: !process.env.CLAIMS_TEST_DATABASE_URL,
  },
  async (t) => {
    const connectionString = process.env.CLAIMS_TEST_DATABASE_URL
    const schema = 'cw_retry_' + randomUUID().replaceAll('-', '')
    const admin = new pg.Pool({ connectionString })
    await admin.query('CREATE SCHEMA ' + schema)
    const db = new pg.Pool({ connectionString, options: '-c search_path=' + schema })
    let stop
    t.after(async () => {
      await stop?.()
      await db.end()
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
      await admin.end()
    })
    await migrate(db)
    await seed(db)
    const interrupted = createDomain(db)
    const user = { tenantId: 'demo', principalId: 'maya', subject: 'test-maya' }
    const approve = async (id, simulateLostAck = false) => {
      const p = await interrupted.prepare(user, id, { expectedVersion: 1, simulateLostAck })
      const approval = await interrupted.review(user, p.id, { decision: 'approve', expectedVersion: 1 })
      return approval.operationId
    }
    const ordinary = await approve('WC-101')
    const missingAck = await approve('WC-102', true)
    assert.equal((await interrupted.operation(user, ordinary)).state, 'queued')
    // The new host uses only reloaded SQL records.
    const restarted = createDomain(db)
    const trace = { run: (_name, call) => call() }
    stop = startLocalDispatchRecovery(restarted, trace, 20)
    const waitFor = async (id, state) => {
      for (let i = 0; i < 200; i++) {
        if ((await restarted.operation(user, id)).state === state) return
        await delay(15)
      }
      assert.fail('Expected operation to reach ' + state)
    }
    await waitFor(ordinary, 'confirmed')
    await waitFor(missingAck, 'unknown')
    const later = await approve('IN-201')
    await waitFor(later, 'confirmed')
    assert.equal((await restarted.operation(user, missingAck)).state, 'unknown')
    assert.equal((await db.query('SELECT count(*)::int n FROM cw_effects')).rows[0].n, 3)
    assert.equal((await restarted.dispatchable()).items.length, 0)
  },
)
