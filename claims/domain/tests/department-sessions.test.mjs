import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { migrate, seed } from '../index.mjs'
import { directory } from '../../auth/roster.mjs'
import { provisionLinks } from '../../auth/identity-links.mjs'
import { nativeOwnership } from '../../shared-chat/ownership.mjs'
import { createDepartmentChat } from '../../portfolios/chat.mjs'
import { createDepartmentAssistant } from '../../portfolios/assistant.mjs'
import { createPortfolioStore } from '../../portfolios/store.mjs'
import { departmentProfiles } from '../../portfolios/profiles.mjs'

test(
  'department conversations retain their owner, scope and history across restarts and recheck access during inference',
  { skip: !process.env.CLAIMS_TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.CLAIMS_TEST_DATABASE_URL
    const schema = 'department_chat_' + randomUUID().replaceAll('-', '')
    const admin = new pg.Pool({ connectionString })
    await admin.query('CREATE SCHEMA ' + schema)
    const pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema })
    t.after(async () => {
      await pool.end()
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
      await admin.end()
    })
    await migrate(pool)
    await seed(pool, { showcase: true })
    const store = createPortfolioStore(pool)
    await store.seed()
    const roster = directory(true, false)
    await provisionLinks(pool, roster)
    const user = roster.employees.find((row) => row.principalId === 'finance')
    const other = roster.employees.find((row) => row.principalId === 'legal')
    const id = 'session-' + randomUUID(),
      second = 'session-' + randomUUID()
    const owner = await nativeOwnership(pool, roster.tenant)
    for (const sid of [id, second]) await owner.bind(user.subject, 'session', sid, 'finance')
    const restarted = await nativeOwnership(pool, roster.tenant)
    assert.equal(restarted.belongs({ ...user, department: 'finance' }, 'session', id), true)
    for (const principal of [other, user, { ...user, department: 'legal' }])
      assert.equal(restarted.belongs(principal, 'session', id), false)
    let duringInference = () => {}
    const assistant = createDepartmentAssistant({
      pool,
      store,
      signal: new AbortController().signal,
      async choose() {
        await duringInference()
        return [1]
      },
    })
    const chat = createDepartmentChat(pool, store, assistant)
    const params = { user, profile: departmentProfiles.finance, id, recheck() {} }
    const scope = { operation: 'scope', write: true, input: { previous: null, recordId: 'FIN-207' } }
    await chat({ ...params, ...scope })
    await chat({ ...params, ...scope, id: second })
    const ask = {
      operation: 'ask',
      write: true,
      input: { recordId: 'FIN-207', requestId: randomUUID(), question: 'What is the variance?' },
    }
    await Promise.all([chat({ ...params, ...ask }), chat({ ...params, ...ask })])
    const read = (args) => chat({ ...params, write: false, input: {}, ...args })
    assert.equal((await read({})).turns.length, 1)
    assert.equal((await read({ id: second })).turns.length, 0)
    await assert.rejects(read({ user: other, profile: departmentProfiles.legal }), { status: 404 })
    // Even a previously authenticated employee loses access if the directory role changes mid-turn.
    duringInference = () =>
      pool.query("UPDATE cw_principals SET role='legal' WHERE profile='finance-v1' AND id='finance'")
    await assert.rejects(chat({ ...params, ...ask, input: { ...ask.input, requestId: randomUUID() } }), {
      status: 404,
    })
    await assert.rejects(read({}), { status: 404 })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM cw_department_answers')).rows[0].n, 1)
  },
)
