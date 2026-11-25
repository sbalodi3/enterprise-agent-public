import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { OidcBrowserSessions } from './sessions.mjs'
import { DEMO_USERS, baselineTenant } from './roster.mjs'

let keys, jwk
before(async () => {
  keys = await generateKeyPair('RS256')
  jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', use: 'sig', alg: 'RS256' }
})

async function fixture(t, overrideDiscovery = metadata => metadata, sessionSeconds = 1800) {
  const codes = new Map()
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, issuer).pathname
    res.setHeader('content-type', 'application/json')
    if (path.endsWith('/.well-known/openid-configuration')) {
      res.end(JSON.stringify(overrideDiscovery({ issuer, authorization_endpoint: base + '/oauth2/v2.0/authorize',
        token_endpoint: base + '/oauth2/v2.0/token', jwks_uri: base + '/discovery/v2.0/keys' })))
    } else if (path.endsWith('/keys')) res.end(JSON.stringify({ keys: [jwk] }))
    else if (path.endsWith('/token')) {
      let body = ''
      for await (const chunk of req) body += chunk
      const form = new URLSearchParams(body)
      const pending = codes.get(form.get('code'))
      codes.delete(form.get('code'))
      if (!pending || form.get('client_secret') !== config.clientSecret
        || createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== pending.challenge) {
        res.writeHead(400); res.end('{}'); return
      }
      const token = await new SignJWT({ sub: 'pairwise-test-subject', tid: baselineTenant, oid: DEMO_USERS[0].objectId,
        nonce: pending.nonce, sid: 'fixture-sid', ...pending.claims })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(pending.issuer || issuer)
        .setAudience(pending.audience || config.clientId).setIssuedAt().setExpirationTime(pending.tokenLifetime || '5m')
        .sign(keys.privateKey)
      res.end(JSON.stringify({ id_token: token, access_token: 'not-exposed', refresh_token: 'not-stored' }))
    } else { res.writeHead(404); res.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/${baselineTenant}`
  const issuer = base + '/v2.0'
  let now = Date.now()
  const config = { appOrigin: 'http://localhost:3080', issuer, clientId: 'claims-workbench', clientSecret: 'synthetic-test-secret-only',
    sessionSeconds, flowSeconds: 300, requestTimeoutMs: 2000, maxSessions: 10, tenant: baselineTenant }
  const peers = []
  const auth = new OidcBrowserSessions(config, { now: () => now,
    resolveEmployee: (tid, oid) => tid === baselineTenant && oid === DEMO_USERS[0].objectId && { ...DEMO_USERS[0], roles: ['adjuster'] },
    createPeer(principal) {
    const control = new AbortController()
    const peer = { principal, signal: control.signal, async dispose() { control.abort() } }
    peers.push(peer)
    return peer
  } })
  t.after(async () => { await auth.dispose(); await new Promise(resolve => server.close(resolve)) })
  await auth.initialize()
  const request = (path, { cookie, method = 'GET', origin, csrf, body, contentType } = {}) => new Request(`${config.appOrigin}${path}`, {
    method, headers: { host: 'localhost:3080', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(contentType ? { 'content-type': contentType } : {}) }, ...(body ? { body } : {}),
  })
  const begin = async (overrides = {}, path = '/auth/login') => {
    const start = await auth.handle(request(path))
    assert.equal(start.status, 303)
    const target = new URL(start.headers.get('location'))
    assert.equal(target.searchParams.get('prompt'), 'select_account')
    const code = randomUUID()
    codes.set(code, { nonce: target.searchParams.get('nonce'), challenge: target.searchParams.get('code_challenge'), ...overrides })
    return { path: `/auth/callback?code=${code}&state=${target.searchParams.get('state')}`, cookie: start.headers.getSetCookie()[0].split(';')[0] }
  }
  const login = async (overrides) => {
    const flow = await begin(overrides)
    const response = await auth.handle(request(flow.path, { cookie: flow.cookie }))
    const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith(auth.cookieName))?.split(';')[0]
    return { response, cookie: sessionCookie, flow }
  }
  return { auth, request, begin, login, config, peers, advance: ms => { now += ms } }
}

test('OIDC code/PKCE gives an opaque session and verified immutable subject; no provider tokens leave the BFF', async t => {
  const f = await fixture(t)
  const login = await f.login()
  assert.equal(login.response.status, 200)
  assert.match(await login.response.text(), /location.replace\('\/'\)/)
  assert.match(login.response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.match(login.cookie, /^claims_session_dev=[A-Za-z0-9_-]{43}$/)
  assert.match(login.response.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/)
  const me = await f.auth.handle(f.request('/auth/me', { cookie: login.cookie }))
  const data = await me.json()
  assert.equal(data.user.principalId, 'maya')
  assert.equal(data.user.subject, DEMO_USERS[0].subject)
  assert.equal(data.user.tenantId, 'demo')
  assert.deepEqual(data.user.roles, ['adjuster'])
  assert.equal(data.user.kind, 'claims-user')
  assert.ok(!JSON.stringify(data).includes('not-exposed'))
  assert.equal(f.auth.admit(f.request('/api/session/list', { cookie: login.cookie })).peer, f.peers[0])
})

test('an explicit Workbench entry survives sign-in and other return destinations are ignored', async t => {
  const f = await fixture(t)
  let login
  f.auth.authorizeIndex(f.request('/?mode=workbench'), {
    writeHead(status, headers) { assert.equal(status,303); login=headers.location }, end() {},
  })
  assert.equal(login, '/auth/login?mode=workbench')
  for (const [path, landing] of [[login, '/?mode=workbench#workbench'], ['/auth/login?mode=other', '/']]) {
    const flow = await f.begin({},path)
    const response = await f.auth.handle(f.request(flow.path,{cookie:flow.cookie}))
    assert.ok((await response.text()).includes("location.replace('" + landing + "')"))
  }
})

test('sign-in restores an exact Claims Agent or PDF destination with fresh credentials', async t => {
  const f = await fixture(t)
  const id = '9d37fa50-1dda-42b1-b1df-c555821c703b'
  const handoff = '/auth/hosted-chat?conversation=' + id
  const viewer = '/claims/view-pdf?conversation=' + id + '&claimId=WC-103&claimVersion=1&documentId=WC-103-shift&documentVersion=1&anchorId=date&format=pdf#nameddest=date'
  const expired = await f.login()
  f.advance(31 * 60000)
  const navigation = f.request(handoff, { cookie: expired.cookie })
  navigation.headers.set('sec-fetch-mode', 'navigate')
  const entry = await f.auth.handle(navigation)
  assert.equal(entry.status, 303)
  assert.equal(new URL(entry.headers.get('location'), f.config.appOrigin).searchParams.get('resume'), handoff)
  assert.equal((await f.auth.handle(f.request(handoff))).status, 401)
  f.advance(-31 * 60000) // The test issuer timestamps newly minted tokens using the real clock.
  for (const [target, expected] of [[handoff, handoff], [viewer, viewer],
    ['/auth/hosted-chat?claim=WC-101', '/auth/hosted-chat?claim=WC-101'],
    ['//other.invalid/', '/'], ['/claims/view-pdf?url=https://example.invalid', '/'],
    [handoff + '&claim=WC-103', '/']]) {
    const flow = await f.begin({}, '/auth/login?' + new URLSearchParams({ resume: target }))
    const response = await f.auth.handle(f.request(flow.path, { cookie: flow.cookie }))
    assert.equal(response.status, 200)
    assert.ok((await response.text()).includes("location.replace('" + expected + "')"))
  }
  const fresh = await f.login()
  const response = await f.auth.handle(f.request('/auth/hosted-chat?claim=WC-101', { cookie: fresh.cookie }))
  assert.equal(response.headers.get('location'), 'http://localhost:3083/open-claims-chat?claim=WC-101')
})

test('discovery requires the configured issuer and exact tenant-scoped endpoints', async t => {
  for (const [field, value] of [
    ['issuer', 'https://other.example.test'],
    ['jwks_uri', 'https://other.example.test/discovery/v2.0/keys'],
    ['token_endpoint', '/common/oauth2/v2.0/token'],
    ['authorization_endpoint', '/' + baselineTenant + '/oauth2/v2.0/token'],
  ]) {
    await assert.rejects(fixture(t, metadata => ({
      ...metadata, [field]: new URL(value, metadata.issuer).href,
    })), { code: 'AUTH_PROVIDER_UNAVAILABLE' })
  }
})

test('callback requires both browser binding and single-use state', async t => {
  const f = await fixture(t)
  const flow = await f.begin()
  assert.equal((await f.auth.handle(f.request(flow.path))).status, 400)
  assert.equal((await f.auth.handle(f.request(flow.path, { cookie: flow.cookie }))).status, 200)
  assert.equal((await f.auth.handle(f.request(flow.path, { cookie: flow.cookie }))).status, 400)
})

test('wrong issuer, audience, nonce, tenant and unmapped directory account cannot log in', async t => {
  const f = await fixture(t)
  for (const override of [
    { issuer: 'https://attacker.invalid' }, { audience: 'another-client' }, { claims: { nonce: 'wrong' } },
    { claims: { tid: 'another-tenant' } }, { claims: { oid: 'unlinked', roles: ['supervisor'], preferred_username: 'maya@example.test' } }, { claims: { oid: null } },
  ]) {
    const result = await f.login(override)
    assert.ok([401, 403].includes(result.response.status))
    assert.equal(result.cookie, undefined)
  }
  assert.equal(f.peers.length, 0)
})

test('state expires and malformed or duplicate callback parameters are refused', async t => {
  const f = await fixture(t)
  const flow = await f.begin()
  assert.equal((await f.auth.handle(f.request(`${flow.path}&code=duplicate`, { cookie: flow.cookie }))).status, 400)
  f.advance(301000)
  const expired = await f.auth.handle(f.request(flow.path, { cookie: flow.cookie }))
  assert.equal(expired.status, 400)
  assert.match(expired.headers.get('content-type'), /^text\/html/)
  assert.equal(expired.headers.get('cache-control'), 'no-store')
  assert.deepEqual(expired.headers.getSetCookie(), [])
  const html = await expired.text()
  assert.match(html, /href="\/auth\/login">Start a new sign-in/)
  assert.ok(!html.includes(new URL(flow.path, f.config.appOrigin).searchParams.get('code')))
  assert.equal(f.peers.length, 0)
})

test('CSRF, Origin and Host are enforced; logout revokes every transport using that Peer', async t => {
  const f = await fixture(t)
  const login = await f.login()
  const { csrfToken } = await (await f.auth.handle(f.request('/auth/me', { cookie: login.cookie }))).json()
  const mutation = { cookie: login.cookie, method: 'POST', origin: f.config.appOrigin }
  assert.throws(() => f.auth.require(f.request('/claims/api/work', mutation), { write: true }), { code: 'AUTH_CSRF_DENIED' })
  assert.throws(() => f.auth.require(f.request('/claims/api/work', { ...mutation, origin: 'http://evil.invalid', csrf: csrfToken }), { write: true }), { code: 'AUTH_ORIGIN_DENIED' })
  assert.equal(f.auth.require(f.request('/claims/api/work', { ...mutation, csrf: csrfToken }), { write: true }).principalId, 'maya')
  const wrongHost = f.request('/auth/me', { cookie: login.cookie }); wrongHost.headers.set('host', '127.0.0.1:3080')
  assert.equal((await f.auth.handle(wrongHost)).status, 403)
  assert.equal((await f.auth.handle(f.request('/auth/logout', { ...mutation, csrf: csrfToken }))).status, 200)
  assert.equal(f.peers[0].signal.aborted, true)
  assert.deepEqual(f.auth.admit(f.request('/api', { cookie: login.cookie })), { rejection: 401 })
})

test('expiry and plugin disposal revoke session admission; a forged browser cookie grants nothing', async t => {
  const f = await fixture(t)
  const login = await f.login()
  assert.equal((await f.auth.handle(f.request('/auth/me', { cookie: 'claims_session_dev=forged' }))).status, 401)
  f.advance(301000)
  assert.equal((await f.auth.handle(f.request('/auth/me', { cookie: login.cookie }))).status, 401)
  assert.equal(f.peers[0].signal.aborted, true)
  await f.auth.dispose()
  assert.equal((await f.auth.handle(f.request('/auth/login'))).status, 503)
})

test('a 12-hour browser session remains valid after a long absence and expires at its configured deadline', async t => {
  const seconds = 12 * 60 * 60
  const f = await fixture(t, undefined, seconds)
  const login = await f.login({ tokenLifetime: '721m' })
  assert.match(login.response.headers.getSetCookie()[0], new RegExp('Max-Age=' + seconds + '$'))
  const me = () => f.auth.handle(f.request('/auth/me', { cookie: login.cookie }))
  f.advance(seconds * 1000 - 1000)
  assert.equal((await me()).status, 200)
  f.advance(1000)
  assert.equal((await me()).status, 401)
  assert.equal(f.peers[0].signal.aborted, true)
})

test('signed-out landing stays anonymous and requires an explicit sign-in click', async t => {
  const f = await fixture(t)
  const response = await f.auth.handle(f.request('/auth/signed-out'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('location'), null)
  assert.deepEqual(response.headers.getSetCookie(), [])
  const html = await response.text()
  assert.match(html, /You are signed out/)
  assert.match(html, /href="\/auth\/login"/)
  assert.ok(!html.includes('<script'))
  assert.equal((await f.auth.handle(f.request('/auth/me'))).status, 401)
})

test('signed backchannel logout revokes matching session; forged requests cannot revoke', async t => {
  const f = await fixture(t)
  const login = await f.login()
  const post = token => f.request('/auth/backchannel-logout', { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams({ logout_token: token }).toString() })
  assert.equal((await f.auth.handle(post('forged'))).status, 400)
  assert.equal((await f.auth.handle(f.request('/auth/me', { cookie: login.cookie }))).status, 200)
  const token = await new SignJWT({ sid: 'fixture-sid', events: { 'http://schemas.openid.net/event/backchannel-logout': {} } })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(f.config.issuer).setAudience(f.config.clientId)
    .setIssuedAt().setJti(randomUUID()).sign(keys.privateKey)
  assert.equal((await f.auth.handle(post(token))).status, 200)
  assert.equal((await f.auth.handle(post(token))).status, 200)
  assert.equal(f.peers[0].signal.aborted, true)
  // A token exchange returning after the IdP's logout must not recreate this session.
  const lateLogin = await f.login()
  assert.equal(lateLogin.response.status, 401)
  assert.equal(f.peers.length, 1)
})

test('directory startup retries temporary transport failures and rejects invalid issuer metadata', async () => {
  const { initializeDirectory } = await import('./index.mjs')
  const signal = new AbortController().signal
  let attempts = 0
  const startup = {async initialize() {
    if (!attempts++) throw new Error('discovery failed', {cause:new TypeError('fetch failed', {cause:{code:'ECONNREFUSED'}})})
  }}
  await initializeDirectory(startup, signal, async () => {})
  assert.equal(attempts, 2)
  const invalid = new Error('discovery failed', { cause: new Error('issuer mismatch') })
  await assert.rejects(initializeDirectory({async initialize() { throw invalid }}, signal, () => assert.fail()), error => error === invalid)
})
