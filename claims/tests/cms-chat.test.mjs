import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import test from 'node:test'
import { CMS_USERS, directory } from '../auth/roster.mjs'
import { employeeResolver } from '../auth/identity-links.mjs'
import { lazyRuntime } from '../desktop-chat/lazy-runtime.mjs'
import { managedChatPorts } from '../desktop-chat/modes.mjs'
import { writeCmsChatCompose } from '../showcase/cms-chat-compose.mjs'

test('CMS account picker, database binding, and private workspaces use the same roster', async t => {
  const enabled = directory(true, true)
  const base = directory(false, true), disabled = directory(true, false)
  const temp = await mkdtemp(join(tmpdir(), 'cms-chat-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const { services } = JSON.parse(await readFile(writeCmsChatCompose(temp), 'utf8'))
  const ports = managedChatPorts(3183, true)
  const volumes = new Set(), bindings = new Set()
  assert.equal(Object.keys(services).length, 21)
  for (const user of CMS_USERS) {
    const service = services['chat-' + user.principalId]
    assert.deepEqual(service.ports, ['127.0.0.1:' + ports[user.principalId] + ':' + ports[user.principalId]])
    assert.equal(service.environment.CLAIMS_LAZY_CHAT, '1')
    assert.equal(service.environment.CLAIMS_DESKTOP_USER, user.principalId)
    volumes.add(service.volumes[0])
    bindings.add(service.ports[0])
    const pool = { query: async (_sql, values) => {
      assert.deepEqual(values, [enabled.tenant, user.objectId, 'demo', 'claims-v1', user.principalId, user.subject])
      return { rows: [{ role: user.role }] }
    } }
    const resolver = employeeResolver(pool, enabled)
    const identity = await resolver(enabled.tenant, user.objectId)
    assert.equal(identity.principalId, user.principalId)
    assert.deepEqual(identity.roles, [user.role])
    for (const roster of [base, disabled]) assert.equal(await employeeResolver(pool, roster)(roster.tenant, user.objectId), undefined)
  }
  assert.equal(volumes.size, 21)
  assert.equal(bindings.size, 21)
  assert.equal(CMS_USERS.find(u => u.principalId === 'claims-admin').role, 'claims_admin')
})

test('concurrent visits share a native runtime and an active turn survives disconnection', async t => {
  let launches = 0, stops = 0, busy = true, check
  const checked = new Promise(resolve => { check = resolve })
  const runtime = lazyRuntime(async () => {
    const number = ++launches
    let finish
    const exited = new Promise(resolve => { finish = resolve })
    return { connection: { number }, exited, idle: async () => { check(); return !busy },
      stop: async () => { stops++; finish() } }
  }, { idleMs: 15 })
  t.after(() => runtime.close())
  const [first, second] = await Promise.all([runtime.acquire(), runtime.acquire()])
  assert.equal(first.number, second.number)
  first.release()
  await wait(40)
  assert.equal(stops, 0)
  second.release()
  await Promise.race([checked, wait(500).then(() => { throw new Error('missing idle probe') })])
  assert.equal(stops, 0)
  busy = false
  for (let i = 0; i < 50 && stops === 0; i++) await wait(10)
  assert.equal(stops, 1)
  const resumed = await runtime.acquire()
  assert.equal(resumed.number, 2)
  resumed.release()
})
