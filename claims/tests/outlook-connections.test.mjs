import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { appId, connectionConfig, createMicrosoft, digest } from '../connections/oauth.mjs'
import { createConnectionStore } from '../connections/store.mjs'
import { createOperationGate, outlookOperations } from '../connections/operations.mjs'

const principal = { principalId: 'maya', tenantId: 'demo', subject: 'maya-sub' }
const alex = { principalId: 'alex', tenantId: 'demo', subject: 'alex-sub' }
const oid = randomUUID(), tenant = randomUUID()
const config = connectionConfig({
  CLAIMS_MS_MODE: 'emulator', CLAIMS_MS_AUTHORITY_ORIGIN: 'http://localhost:4005',
  CLAIMS_MS_INTERNAL_ORIGIN: 'http://microsoft:4005', CLAIMS_MS_GRAPH_ORIGIN: 'http://microsoft:4005',
  CLAIMS_MS_TENANT_ID: tenant, CLAIMS_MS_CLIENT_ID: 'ms-test', CLAIMS_MS_CLIENT_SECRET: 'test-only-ms-secret',
  CLAIMS_APP_ORIGIN: 'http://localhost:3080', CLAIMS_MS_TOKEN_KEY: randomBytes(32).toString('base64'),
  CLAIMS_MS_ACCOUNT_MAP: JSON.stringify({ 'demo/maya-sub': oid, 'demo/alex-sub': randomUUID() }),
})

test('operation gates require all declared apps and invalidate in-flight composite results', async () => {
  const states = new Map([['outlook-mail', { version: 1, status: 'off' }], ['teams', { version: 3, status: 'off' }]])
  let acquired = 0, dispatched = 0
  const run = createOperationGate({
    operations: { ...outlookOperations, 'teams.read': ['teams'], 'search.both': ['outlook-mail', 'teams'], 'search.all': [] },
    status: async (_, id) => ({ id, available: true, ...states.get(id) }),
    withAccess: async (_, id, callback, { expectedVersion, signal }) => {
      acquired++
      const verify = () => assert.deepEqual(states.get(id), { status: 'connected', version: expectedVersion })
      verify()
      const value = await callback({ id, signal })
      verify()
      return value
    },
  })
  const call = () => { dispatched++; return 'allowed' }
  await assert.rejects(run(principal, 'outlook.search', call))
  states.set('outlook-mail', { version: 2, status: 'connected' })
  for (const op of ['teams.read', 'search.both', 'search.all', 'unknown', 'toString'])
    await assert.rejects(run(principal, op, call))
  assert.equal(acquired, 0)
  assert.equal(dispatched, 0)
  assert.equal(await run(principal, 'outlook.read', call), 'allowed')
  states.set('teams', { version: 4, status: 'connected' })
  const requested = Promise.withResolvers(), finish = Promise.withResolvers()
  const pending = run(principal, 'search.both', async leases => {
    assert.deepEqual([...leases.keys()], ['outlook-mail', 'teams'])
    requested.resolve()
    await finish.promise
    return 'private result'
  })
  await requested.promise
  states.set('outlook-mail', { version: 3, status: 'off' })
  finish.resolve()
  await assert.rejects(pending)
})

test('Microsoft tokens require PKCE, consent scope, a signed matching workforce account, and working mailbox access', async () => {
  const key = await generateKeyPair('RS256'), wrong = await generateKeyPair('RS256')
  const pub = { ...await exportJWK(key.publicKey), alg: 'RS256', kid: 'test' }
  const flow = { state: 'test-state', nonce: 'test-nonce', verifier: 'test-verifier' }
  let idOptions = {}, scope = 'openid profile Mail.Read', signer = key, mailbox = true, probes = 0
  let publishedKey = pub, signingKid = pub.kid, keyReads = 0
  const ms = createMicrosoft(config, async (url, init) => {
    assert.equal(new URL(url).origin, config.transport)
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({
      issuer: config.issuer, authorization_endpoint: config.authority + '/authorize',
      token_endpoint: config.authority + '/token', jwks_uri: config.authority + '/keys',
    })
    if (url.endsWith('/keys')) { keyReads++; return Response.json({ keys: [publishedKey] }) }
    if (url.includes('/v1.0/me/messages')) {
      probes++
      assert.equal(init.headers.authorization, 'Bearer access')
      return Response.json({ value: [] }, { status: mailbox ? 200 : 403 })
    }
    if (!url.endsWith('/token')) throw new Error('unexpected request')
    assert.equal(init.body.get('client_secret'), config.secret)
    if (init.body.get('grant_type') === 'refresh_token') return Response.json({
      access_token: 'access2', refresh_token: 'rotated', expires_in: 3600, token_type: 'Bearer', scope,
    })
    assert.equal(init.body.get('code_verifier'), flow.verifier)
    assert.equal(init.body.get('redirect_uri'), config.redirect)
    const id_token = await new SignJWT({ sub: 'ms-user', tid: tenant, oid, nonce: flow.nonce, preferred_username: 'maya@example.test',
      iss: config.issuer, aud: config.clientId, ...idOptions }).setProtectedHeader({ kid: signingKid, alg: 'RS256' })
      .setIssuedAt().setExpirationTime('5m').sign(signer.privateKey)
    return Response.json({ id_token, scope, access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 })
  })
  const url = new URL(await ms.authorizationUrl(flow))
  assert.equal(url.origin, config.authority)
  assert.equal(url.searchParams.get('code_challenge'), digest(flow.verifier))
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('scope').includes('https://graph.microsoft.com/Mail.Read'))
  const linked = await ms.exchange('code', flow, oid)
  assert.equal(linked.accountId, tenant + '/' + oid)
  assert.equal((await ms.refresh(linked.tokens)).refresh, 'rotated')
  for (const invalid of [{ tid: randomUUID() }, { oid: randomUUID() }, { nonce: 'wrong' },
    { aud: 'overseas' }, { iss: config.issuer + '/other' }, { azp: 'other-client' }]) {
    idOptions = invalid
    await assert.rejects(ms.exchange('code', flow, oid), { status: 403 })
  }
  idOptions = {}
  signer = wrong
  await assert.rejects(ms.exchange('code', flow, oid), { code: 'microsoft_identity_invalid' })
  signer = key
  scope = 'openid profile'
  await assert.rejects(ms.exchange('code', flow, oid), { code: 'microsoft_mail_scope_required' })
  assert.equal(probes, 1)
  scope = 'Mail.Read'
  mailbox = false
  await assert.rejects(ms.exchange('code', flow, oid), { code: 'microsoft_mailbox_unavailable' })
  mailbox = true
  signer = wrong
  signingKid = 'rotated'
  publishedKey = { ...await exportJWK(signer.publicKey), alg: 'RS256', kid: signingKid }
  const before = keyReads
  assert.equal((await ms.exchange('code', flow, oid)).accountId, linked.accountId)
  assert.equal(keyReads, before + 1)
})

test('PostgreSQL grants bind each workflow to its session, encrypt tokens, serialize refresh, and suppress stale results', {
  skip: !process.env.CLAIMS_TEST_DATABASE_URL,
}, async t => {
  const connectionString = process.env.CLAIMS_TEST_DATABASE_URL
  const schema = 'ms_test_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema })
  t.after(async () => {
    await pool.end()
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
    await admin.end()
  })
  const migration = await readFile(new URL('../domain/migrations/012.sql', import.meta.url), 'utf8')
  await pool.query(migration)
  await pool.query('ALTER TABLE cw_connection_accounts ALTER COLUMN encrypted_tokens SET NOT NULL')
  await pool.query(migration)
  let refreshCount = 0, invalidRefresh = false
  let exchangeWait
  const options = { pool, config, microsoft: {
    async authorizationUrl({ state }) { return 'http://localhost/authorize?state=' + state },
    async exchange() {
      if (exchangeWait) await exchangeWait()
      return { accountId: tenant + '/' + oid, address: 'maya@example.test',
        tokens: { access: 'original-secret', refresh: 'refresh-secret', expires: 0 } }
    },
    async refresh() {
      if (invalidRefresh) throw Object.assign(new Error('invalid'), { code: 'microsoft_reconnect_required' })
      refreshCount++
      return { access: 'new-secret', refresh: 'rotated', expires: Date.now() + 3600000 }
    },
  } }
  const service = createConnectionStore(options), otherHost = createConnectionStore(options)
  const begin = async () => {
    const { url } = await service.begin(principal, 'this-browser')
    const params = new URL(url).searchParams
    params.set('code', 'one-use-code')
    return params
  }
  const complete = params => service.complete(principal, 'this-browser', params, () => {})
  const lease = (service, fn, constraints) => service.withAccess(principal, appId, fn, constraints)
  const params = await begin()
  await assert.rejects(service.complete(alex, 'this-browser', params, () => {}), { code: 'microsoft_callback_expired' })
  await assert.rejects(service.complete(principal, 'another-browser', params, () => {}), { code: 'microsoft_callback_expired' })
  await complete(params)
  await assert.rejects(complete(params), { code: 'microsoft_callback_expired' })
  const connected = await service.status(principal)
  assert.equal(connected.status, 'connected')
  assert.equal((await service.status(alex)).status, 'off')
  assert.doesNotMatch((await pool.query('SELECT encrypted_tokens FROM cw_connection_accounts')).rows[0].encrypted_tokens, /original-secret|refresh-secret/)
  await Promise.all([service, otherHost].map(host => lease(host, async auth => assert.equal(auth.token, 'new-secret'))))
  assert.equal(refreshCount, 1)
  const start = Promise.withResolvers(), finish = Promise.withResolvers()
  const delayed = lease(otherHost, async auth => { await auth.check(); start.resolve(auth); await finish.promise; return 'private' })
  const ongoingLease = await start.promise
  await service.disconnect(principal)
  // The losing host hasn't received a local abort signal, but a next page/retry
  // must observe the committed change before sending another Graph request.
  assert.equal(ongoingLease.signal.aborted, false)
  await assert.rejects(ongoingLease.check(), { code: 'microsoft_connection_changed' })
  finish.resolve()
  await assert.rejects(delayed, { code: 'microsoft_connection_changed' })
  const account = async () => (await pool.query('SELECT account_id,address,encrypted_tokens FROM cw_connection_accounts')).rows[0]
  const disconnected = { account_id: connected.accountId, address: connected.address, encrypted_tokens: null }
  assert.deepEqual(await account(), disconnected)
  const off = await service.status(principal)
  assert.equal(off.status, 'off')
  assert.equal(off.accountId, connected.accountId)
  await assert.rejects(lease(service, () => assert.fail(), { expectedVersion: connected.version }), { code: 'microsoft_connection_changed' })

  const pending = await begin(), started = Promise.withResolvers(), resume = Promise.withResolvers()
  exchangeWait = () => { started.resolve(); return resume.promise }
  const lateCallback = complete(pending)
  await started.promise
  await otherHost.disconnect(principal)
  resume.resolve()
  await assert.rejects(lateCallback, { code: 'microsoft_connection_changed' })
  exchangeWait = null
  const denied = await begin()
  denied.set('error', 'access_denied')
  await assert.rejects(complete(denied), { code: 'microsoft_consent_declined' })
  assert.equal((await service.status(principal)).status, 'off')
  await complete(await begin())
  invalidRefresh = true
  await assert.rejects(lease(service, () => assert.fail()), { code: 'microsoft_reconnect_required' })
  assert.equal((await service.status(principal)).status, 'reconnect')
  assert.deepEqual(await account(), disconnected)
  invalidRefresh = false
  await complete(await begin())
  const valid = await service.status(principal)
  assert.equal(await service.commitIfCurrent(principal, appId, valid.version, async db =>
    (await db.query('SELECT 42 AS value')).rows[0].value), 42)
  await assert.rejects(lease(service, async () => {
    throw Object.assign(new Error('Graph rejected token'), { status: 401, code: 'microsoft_reconnect_required' })
  }), { code: 'microsoft_reconnect_required' })
  assert.equal((await service.status(principal)).status, 'reconnect')
  await assert.rejects(service.commitIfCurrent(principal, appId, valid.version, () => assert.fail()), { code: 'microsoft_connection_changed' })
  assert.deepEqual(await account(), disconnected)
  await complete(await begin())
  await pool.query(`INSERT INTO cw_connection_grants(tenant,subject,app,provider,status,version) VALUES
    ('demo','maya-sub','fixture-teams','microsoft','connected',12)`)
  const prior = await account()
  await service.disconnect(principal)
  assert.deepEqual(await account(), prior, 'the sibling app retains its own grant and shared credential cache')
  assert.equal((await service.status(principal)).status, 'off')
  assert.deepEqual((await pool.query("SELECT status,version FROM cw_connection_grants WHERE app='fixture-teams'")).rows,
    [{ status: 'connected', version: 12 }])
  await assert.rejects(lease(service, () => assert.fail()), { code: 'microsoft_connection_changed' })
  await complete(await begin())
  const retiredKey = createConnectionStore({ ...options, config: { ...config, key: randomBytes(32) } })
  await assert.rejects(lease(retiredKey, () => assert.fail()), { code: 'microsoft_reconnect_required' })
  assert.equal((await service.status(principal)).status, 'reconnect')
  assert.deepEqual(await account(), disconnected)
})
