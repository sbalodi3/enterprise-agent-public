import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { migrate, seed } from '../domain/index.mjs'
import { employeeResolver, provisionLinks } from './identity-links.mjs'
import { directory, showcaseTenant } from './roster.mjs'

test('only exact directory links to existing employee principals admit a claims identity',
  { skip: !process.env.CLAIMS_TEST_DATABASE_URL }, async t => {
    const schema = 'entra_test_' + randomUUID().replaceAll('-', '')
    const connectionString = process.env.CLAIMS_TEST_DATABASE_URL
    const admin = new pg.Pool({ connectionString })
    await admin.query('CREATE SCHEMA ' + schema)
    const pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema })
    t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
    const roster = directory(false)
    const [maya, alex] = roster.employees
    const resolve = employeeResolver(pool, roster)
    await migrate(pool)
    await seed(pool)
    assert.equal(await resolve(roster.tenant, maya.objectId), undefined)
    await Promise.all([provisionLinks(pool, roster), provisionLinks(pool, roster)])
    assert.equal((await pool.query('SELECT * FROM cw_entra_identities')).rowCount, 3)
    assert.equal((await resolve(roster.tenant, maya.objectId)).subject, maya.subject)
    assert.equal(await resolve(showcaseTenant, maya.objectId), undefined)
    assert.equal(await resolve(roster.tenant, randomUUID()), undefined)
    await pool.query("UPDATE cw_principals SET role='supervisor' WHERE (tenant,profile,id)=('demo','claims-v1','maya')")
    assert.deepEqual((await resolve(roster.tenant, maya.objectId)).roles, ['supervisor'])
    // An old or incorrect link to a namesake must not acquire the rostered employee's access.
    for (const [tenant, profile] of [['isolation','claims-v1'], ['demo','legal-test-v1']]) {
      await pool.query('UPDATE cw_entra_identities SET tenant=$1,profile=$2 WHERE subject=$3', [tenant,profile,maya.subject])
      assert.equal(await resolve(roster.tenant, maya.objectId), undefined)
      await assert.rejects(provisionLinks(pool, roster), /Cannot provision Entra identity for maya@example.test/)
    }
    assert.equal((await resolve(roster.tenant, alex.objectId)).principalId, 'alex')
  })
