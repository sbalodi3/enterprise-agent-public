import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { startMailLab } from './lab.mjs'
import { createConnections } from '../../connections/http.mjs'
import { readOutlook, searchOutlook } from '../../connections/graph.mjs'
import { createGraphClient } from '../../connections/graph-client.mjs'
import { migrate } from '../../domain/index.mjs'
import { employeeResolver, provisionLinks } from '../../auth/identity-links.mjs'
import { CMS_USERS, directory } from '../../auth/roster.mjs'
import { validateSnapshot } from '../../showcase/cms-mcp/snapshot.mjs'
import { verifyCmsMailTurns } from './cms-mail-turns.mjs'
import { verifyInboxChoice } from './inbox-choice.mjs'

async function setup(t, { cmsSnapshot, showcase = Boolean(cmsSnapshot) } = {}) {
  const cms = Boolean(cmsSnapshot)
  assert.ok(process.env.CLAIMS_TEST_DATABASE_URL, 'Provide CLAIMS_TEST_DATABASE_URL for a disposable PostgreSQL database')
  const admin = new pg.Pool({ connectionString: process.env.CLAIMS_TEST_DATABASE_URL })
  const schema = 'outlook_test_' + randomUUID().replaceAll('-', '')
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: process.env.CLAIMS_TEST_DATABASE_URL, options: '-c search_path=' + schema })
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await migrate(pool)
  let service
  let handler = (req, res) => service.handle(req, res)
  const server = createServer((req,res) => { void handler(req,res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = 'http://127.0.0.1:' + server.address().port
  const lab = await startMailLab(origin, { cms, cmsSnapshot, showcase })
  t.after(() => lab.emulator.close())
  // The session cookie is a fixture. Resolve its employee through the same persisted
  // Entra links used by the workbench before passing that principal to the mail service.
  const roster = directory(showcase, cms)
  const owners = []
  const resolve = employeeResolver(pool, roster)
  for (const owner of lab.owners) {
    await pool.query('INSERT INTO cw_principals(id,tenant,profile,role) VALUES ($1,$2,$3,$4)',
      [owner.principalId, owner.tenantId, owner.profile, owner.profile === 'claims-v1' ? 'adjuster' : owner.principalId])
  }
  await provisionLinks(pool, { tenant: roster.tenant, employees: lab.owners })
  for (const owner of lab.owners) {
    const principal = await resolve(roster.tenant, owner.objectId)
    assert.equal(principal?.subject, owner.subject)
    assert.equal(principal.principalId, owner.principalId)
    owners.push(principal)
  }
  const who = req => {
    const user = owners.find(u => req.headers.cookie === 'employee=' + u.principalId)
    assert.ok(user)
    return user
  }
  const binding = req => 'session-binding-' + who(req).principalId
  let refreshes = 0
  const auth = {
    admit: () => ({peer:{signal:new AbortController().signal}}),
    require(req, { write } = {}) { if (write) assert.equal(req.headers['x-csrf-token'], binding(req)); return who(req) },
    browserCsrf: binding, microsoftCallbackSession: req => ({ principal: who(req), binding: binding(req) }),
  }
  service = createConnections({ pool, env: lab.env, auth, fetch: async (url, init) => {
    const response = await fetch(url, init)
    if (init.body instanceof URLSearchParams) {
      if (init.body.get('grant_type') === 'refresh_token') refreshes++
      if (init.body.get('grant_type') === 'authorization_code' && response.ok) {
        // Exercise silent refresh on the next operation without waiting for an hour.
        return Response.json({ ...await response.json(), expires_in: 1 })
      }
    }
    return response
  } })
  const request = (user, path, method = 'GET', input) => fetch(origin + path, { method,
    body: input === undefined ? undefined : JSON.stringify(input),
    headers: { 'content-type':'application/json', cookie: 'employee=' + user.principalId, 'x-csrf-token': 'session-binding-' + user.principalId } })
  async function consent(user, address, expectedStatus = 200) {
    const base = '/claims/api/connections/outlook-mail/'
    const begin = await request(user, base + 'connect', 'POST')
    assert.equal(begin.status, 200)
    const { url } = await begin.json()
    const authorize = new URL(url)
    const picker = await fetch(authorize)
    assert.match(await picker.text(), /Choose|Sign in/)
    const form = new URLSearchParams(authorize.search)
    form.set('email', address)
    const grant = await fetch(new URL('/oauth2/v2.0/authorize/callback', authorize), { method:'POST', body:form, redirect:'manual' })
    assert.ok([302,303].includes(grant.status))
    const callback = new URL(grant.headers.get('location'))
    const complete = await request(user, callback.pathname + callback.search)
    assert.equal(complete.status, expectedStatus, await complete.text())
    const status = await service.status(user)
    assert.equal(status.status, expectedStatus === 200 ? 'connected' : 'off')
    if (expectedStatus === 200) assert.equal(status.address, address)
  }
  return { lab, pool, owners, service, request, consent, auth, mount: api => { handler = api }, refreshCount: () => refreshes }
}

test('ambiguous inbox resumes the selected source and protects its separate history', async t => {
  await verifyInboxChoice(t, await setup(t))
})

test('two employee sessions consent, refresh, search and read only their own emulated Outlook mailbox', async t => {
  const { lab, owners, service, request, consent, refreshCount } = await setup(t)
  const graph = { origin: lab.env.CLAIMS_MS_GRAPH_ORIGIN }
  for (const [i, user] of owners.entries()) {
    await consent(user, lab.users[i].email)
    const result = await service.withAccess(user, 'outlook-mail', lease => searchOutlook(lease,
      { query:'Westfield invoice', timeZone:'America/New_York' }, graph))
    assert.deepEqual(result.items.map(r => r.id), ['invoice-' + i, 'update-' + i])
    const latest = await service.withOperation(user, 'outlook.search', leases => searchOutlook(leases.get('outlook-mail'),
      { query:'Westfield invoice', order:'latest' }, graph))
    assert.deepEqual(latest.items.map(r => r.id), ['update-' + i, 'invoice-' + i])
    const unread = await service.withAccess(user, 'outlook-mail', lease => searchOutlook(lease,
      { folder:'inbox', unreadOnly:true }, graph))
    const unreadIds = unread.items.map(row => row.id)
    assert.ok(unreadIds.includes('update-' + i))
    assert.ok(!unreadIds.includes('draft-' + i) && !unreadIds.includes('invoice-' + i))
    const byDate = await service.withOperation(user, 'outlook.search', leases => searchOutlook(leases.get('outlook-mail'),
      { query: 'Westfield', from: '2026-11-19', to: '2026-11-19', timeZone: 'America/New_York' }, graph))
    assert.deepEqual(byDate.items.map(item => item.id), ['update-' + i])
    const bySubject = await service.withOperation(user, 'outlook.search', leases => searchOutlook(leases.get('outlook-mail'),
      { subject: 'Westfield invoice', sender: 'payroll@example.test' }, graph))
    assert.deepEqual(bySubject.items.map(item => item.id), ['invoice-' + i])
    const hit = await service.withAccess(user, 'outlook-mail', lease => readOutlook(lease, result.items[0].id, graph))
    assert.match(hit.text, i ? /ALEX-821/ : /MAYA-141/)
    await assert.rejects(service.withAccess(user,'outlook-mail', lease => readOutlook(lease, 'invoice-' + (1-i),graph)))
  }
  assert.equal(refreshCount(), 2)
  const [maya,alex] = owners
  await request(maya,'/claims/api/connections/outlook-mail/disconnect','POST')
  assert.equal((await service.status(maya)).status, 'off')
  assert.equal((await service.status(alex)).status, 'connected')
  await assert.rejects(service.withAccess(maya, 'outlook-mail', () => assert.fail('provider called after disconnect')))
})


test('Claims, Finance and Legal grants each resolve just the signed-in mailbox', async t => {
  const { lab, owners, service, consent } = await setup(t, { showcase: true })
  const graph = {origin:lab.env.CLAIMS_MS_GRAPH_ORIGIN}
  const employees = owners.filter(user => user.principalId !== 'alex')
  const messages = new Map()
  for (const [index, user] of employees.entries()) {
    const other = employees[(index + 1) % employees.length]
    await consent(user, other.principalId + '@example.test', 403)
    await consent(user, user.principalId + '@example.test')
    const result = await service.withAccess(user, 'outlook-mail', lease => searchOutlook(lease, {query:'Westfield invoice'},graph))
    messages.set(user, result.items[0].id)
    const own = await service.withAccess(user, 'outlook-mail', lease => readOutlook(lease, messages.get(user), graph))
    assert.match(own.text, {maya:/MAYA-141/,finance:/FIN-207/,legal:/MAT-017/}[user.principalId])
  }
  for (const user of employees) for (const [other,id] of messages) {
    if (other !== user) await assert.rejects(service.withAccess(user, 'outlook-mail',lease => readOutlook(lease,id,graph)))
  }
})

test('all CMS adjusters consent and read only their own assigned claims’ mail', async t => {
  const path = process.env.CLAIMS_CMS_TEST_SNAPSHOT ||
    new URL('../../../.artifacts/claims-showcase/cms-mcp/snapshot.json', import.meta.url)
  const cmsSnapshot = validateSnapshot(JSON.parse(await readFile(path, 'utf8')))
  const { lab, pool, owners, service, consent } = await setup(t, { cmsSnapshot })
  const adjusters = CMS_USERS.filter(person => person.sourceAdjusterId)
  const assigned = owners.filter(owner => owner.principalId.startsWith('cms-adjuster-'))
  assert.equal(assigned.length, 20)
  const claimRows = new Map(cmsSnapshot.rows.map(row => [row.externalClaimNumber, row]))
  const mailboxes = adjusters.map(adjuster => {
    const principal = assigned.find(person => person.principalId === adjuster.principalId)
    assert.ok(principal)
    const claims = cmsSnapshot.rows.filter(row => row.sourceAdjusterId === adjuster.sourceAdjusterId)
      .map(row => row.externalClaimNumber)
    assert.equal(claims.length, 10)
    return { principal, address: adjuster.upn, claims }
  })
  const graph = { origin: lab.env.CLAIMS_MS_GRAPH_ORIGIN }
  for (const [index, mailbox] of mailboxes.entries()) {
    await t.test(mailbox.principal.principalId, async () => {
      const { principal, address, claims } = mailbox
      const nextMailbox = mailboxes[(index + 1) % mailboxes.length]
      await consent(principal, nextMailbox.address, 403)
      await consent(principal, address)
      await service.withAccess(principal, 'outlook-mail', async lease => {
        const client = createGraphClient(lease, graph)
        const inbox = await client.request('/v1.0/me/messages?$top=50')
        assert.equal(inbox['@odata.nextLink'], undefined)
        const ids = inbox.value.map(message => message.id)
        assert.deepEqual(ids.filter(id => id.startsWith('CLM-')).sort(),
          claims.flatMap(claim => [claim + '-correspondence', claim + '-update']).sort())
        // The emulator also supplies standard messages scoped to each account.
        const demoPrefix = address.replace(/[^a-z0-9]+/g, '_') + '_msg_'
        assert.ok(ids.filter(id => !id.startsWith('CLM-')).every(id => id.startsWith(demoPrefix)))

        for (const claim of claims) {
          const row = claimRows.get(claim)
          const result = await searchOutlook(lease, { query: claim }, graph)
          assert.deepEqual(result.items.map(item => item.subject).sort(), [claim + ' correspondence', claim + ' review update'])
          assert.equal(result.partial, false)
          for (const { id, subject } of result.items) {
            const message = await readOutlook(lease, id, graph)
            assert.equal(message.subject, subject)
            assert.ok(message.text.includes(claim))
            if (id.endsWith('-correspondence')) {
              assert.ok(message.text.includes(row.lineOfBusinessName))
              assert.ok(message.text.includes(row.incidentDate) && message.text.includes(row.reportedDate))
            } else {
              assert.ok(message.text.includes(row.sourceStatus))
            }
          }
        }
        const foreignClaim = nextMailbox.claims[0]
        assert.deepEqual((await searchOutlook(lease, { query: foreignClaim }, graph)).items, [])
        assert.deepEqual((await searchOutlook(lease, { query: foreignClaim, order: 'latest' }, graph)).items, [])
        for (const other of mailboxes) {
          if (other === mailbox) continue
          await assert.rejects(readOutlook(lease, other.claims[0] + '-correspondence', graph),
            { status: 404, code: 'graph_resource_unavailable' }, other.address)
        }
      })
    })
  }
  await verifyCmsMailTurns(t, { pool, connections: service, mailboxes, cmsSnapshot })
})
