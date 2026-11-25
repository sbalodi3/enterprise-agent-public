import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { DEMO_USERS } from '../auth/config.mjs'
const { WebSocket, WebSocketServer } = createRequire(new URL('../../packages/api/gateway/package.json', import.meta.url))('ws')
import test from 'node:test'
import { isChatBridgeRoute } from '../desktop-chat/claim-routes.mjs'
import { pairPrivateChat, startDesktopGateway } from '../desktop-chat/gateway.mjs'

test('the employee claims bridge allows only named methods and resource shapes', () => {
  const conversation = '9d37fa50-1dda-42b1-b1df-c555821c703b'
  for (const [method, path] of [['POST', 'route'], ['POST', 'scope/' + conversation], ['GET', 'documents/WC-101']]) {
    assert.ok(isChatBridgeRoute(method, '/claims/api/chat/' + path))
    assert.equal(isChatBridgeRoute(method === 'GET' ? 'POST' : 'GET', '/claims/api/chat/' + path), false)
  }
  for (const path of ['/claims/api/chat/documents/WC-101/private', '/claims/api/media/WC-101/file', '/claims/api/chat/scope/all']) {
    assert.equal(isChatBridgeRoute('GET', path), false)
    assert.equal(isChatBridgeRoute('POST', path), false)
  }
})

test('desktop requests follow the workstation assignment and the live application session', async t => {
  const [user, alex] = DEMO_USERS
  const cookie = 'claims_session_dev=synthetic'
  const privateCookie = 'dsh-auth-synthetic=private'
  let verified = user, reachable = true, relayed, revoke
  const native = http.createServer((req, res) => {
    if (req.url === '/?token=fixture') return res.writeHead(303, { 'set-cookie': privateCookie + '; HttpOnly' }).end()
    relayed = req.headers
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'private=neverForwardToBrowser' }).end('desktop')
  })
  const mux = new WebSocketServer({ noServer: true })
  native.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/api/remote.mux')
    assert.equal(req.headers.cookie, privateCookie)
    mux.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data)))
  })
  native.listen(0, '127.0.0.1')
  await once(native, 'listening')
  t.after(() => { native.closeAllConnections(); native.close() })
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url).startsWith('http://localhost:3080/')) {
      assert.equal(options.headers.cookie, cookie)
      if (!reachable) return Promise.reject(new Error('offline'))
      if (String(url).endsWith('/auth/me')) return Promise.resolve(Response.json({ user: verified }))
      assert.ok(String(url).endsWith('/auth/session-watch'))
      const stream = new ReadableStream({
        start(controller) {
          let open = true
          revoke = () => { if (open) { open = false; controller.close() } }
          options.signal.addEventListener('abort', revoke, { once: true })
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    return originalFetch(url, options)
  })
  let bridged
  const authority = http.createServer((req, res) => {
    assert.equal(req.headers.host, 'localhost:3080')
    assert.equal(req.headers.cookie, cookie)
    if (req.url === '/claims/api/media/WC-101/WC-101-report') return res.writeHead(200).end('synthetic media')
    if (req.url === '/auth/me') return res.writeHead(200).end(JSON.stringify({ user: verified }))
    if (req.url === '/claims/api/chat/bootstrap') {
      bridged = req.headers
      return res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'should-stay-private=value' }).end('{"enabled":true}')
    }
    assert.equal(req.url, '/auth/session-watch')
    res.writeHead(200, { 'content-type': 'text/event-stream' }).write(': active\n\n')
  })
  authority.listen(0, '127.0.0.1')
  await once(authority, 'listening')
  t.after(() => { authority.closeAllConnections(); authority.close() })
  const originalGet = http.get
  const originalRequest = http.request
  t.mock.method(http, 'request', (options, callback) =>
    (options.hostname === 'host.docker.internal' || options.hostname === 'localhost' && options.port === '3080')
      ? originalRequest({ ...options, hostname: '127.0.0.1', port: authority.address().port }, callback)
      : originalRequest(options, callback))
  t.mock.method(http, 'get', (options, callback) => {
    if (options.hostname === 'host.docker.internal') {
      assert.equal(options.port, 3080)
      return originalGet({ ...options, hostname: '127.0.0.1', port: authority.address().port }, callback)
    }
    return originalGet(options, callback)
  })
  // Preserve the production authority checks while using a free port for this fixture.
  const listen = http.Server.prototype.listen
  t.mock.method(http.Server.prototype, 'listen', function (port, ...args) {
    assert.ok([3081, 3084].includes(port))
    return listen.call(this, 0, '127.0.0.1', args.at(-1))
  })
  const launchUrl = 'http://127.0.0.1:' + native.address().port + '/?token=fixture'
  const server = await startDesktopGateway({ user, launchUrl })
  let nativeStarts = 0
  const managed = await startDesktopGateway({ user: alex, managedPort: 3084, acquireNative: async () => {
    nativeStarts++
    return { ...await pairPrivateChat(launchUrl, 3084), release() {} }
  } })
  t.after(() => { managed.closeAllConnections(); managed.close() })
  t.after(() => { server.closeAllConnections(); server.close() })
  function get(path, headers = {}, hosted = false) {
    return new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1', port: (hosted ? managed : server).address().port, path,
        headers: { host: hosted ? 'localhost:3084' : 'localhost:3081', ...headers },
      }, resolve).on('error', reject)
    })
  }

  const entry = await get('/')
  assert.equal(entry.statusCode, 303)
  assert.equal(entry.headers.location, 'http://localhost:3080/auth/login')
  entry.resume()
  assert.equal((await get('/api')).statusCode, 401)
  assert.equal((await get('/api', { cookie, host: 'elsewhere.test' })).statusCode, 403)
  assert.equal((await get('/api', { cookie, origin: 'http://localhost:3080' })).statusCode, 403)
  assert.equal((await get('/connect', { cookie })).statusCode, 403)
  const present = await get('/desktop/presence', { origin: 'http://localhost:3080' })
  assert.equal(present.statusCode, 204)
  assert.equal(present.headers['access-control-allow-origin'], 'http://localhost:3080')
  assert.equal((await get('/desktop/presence', { origin: 'http://localhost:3080' }, true)).statusCode, 403)
  assert.equal((await get('/open-chat', { cookie }, true)).statusCode, 403)
  assert.equal((await get('/api', { cookie }, true)).statusCode, 403)
  assert.equal((await get('/api', {}, true)).statusCode, 401)
  assert.equal(nativeStarts, 0)
  verified = alex
  assert.equal((await get('/open-chat', { cookie })).headers.location, 'http://localhost:3084/open-chat')
  assert.equal((await get('/open-chat', { cookie }, true)).statusCode, 200)
  const claimsEntry = await get('/open-claims-chat?conversation=9d37fa50-1dda-42b1-b1df-c555821c703b', { cookie }, true)
  assert.equal(claimsEntry.statusCode, 200)
  let document = ''
  for await (const chunk of claimsEntry) document += chunk
  assert.match(document, /conversation=9d37fa50-1dda-42b1-b1df-c555821c703b#claim-chat/)
  const claimsResponse = await get('/claims/api/chat/bootstrap', { cookie, authorization: 'untrusted', 'x-csrf-token': 'csrf' }, true)
  assert.equal(claimsResponse.statusCode, 200)
  assert.equal(claimsResponse.headers['set-cookie'], undefined)
  assert.equal(bridged.cookie, cookie)
  assert.equal(bridged['x-csrf-token'], 'csrf')
  assert.equal(bridged.authorization, undefined)
  assert.equal(bridged.origin, 'http://localhost:3080')
  assert.equal((await get('/claims/api/wages', { cookie }, true)).statusCode, 404)
  assert.equal(nativeStarts, 0)
  assert.equal((await get('/api', { cookie }, true)).statusCode, 200)
  assert.equal(nativeStarts, 1)
  relayed = undefined
  verified = { ...user, subject: 'two' }
  assert.equal((await get('/', { cookie })).statusCode, 403)
  reachable = false
  assert.equal((await get('/', { cookie })).statusCode, 503)
  assert.equal(relayed, undefined)

  verified = user
  reachable = true
  const workstationClaims = await get('/claims/api/chat/bootstrap', { cookie })
  assert.equal(workstationClaims.statusCode, 200)
  workstationClaims.resume()
  assert.equal(bridged.cookie, cookie)
  const localEntry = await get('/open-claims-chat?claim=WC-101', { cookie })
  let localPage = ''
  for await (const chunk of localEntry) localPage += chunk
  assert.match(localPage, /claim=WC-101#claim-chat/)
  assert.equal((await get('/claims/api/media/WC-101/WC-101-report', { cookie })).statusCode, 200)
  assert.equal((await get('/claims/api/items/WC-101/internal', { cookie })).statusCode, 404)
  assert.equal((await get('/desktop/workbench/me', { cookie })).statusCode, 200)
  assert.equal((await get('/claims/api/wages', { cookie })).statusCode, 404)
  const expiredEntry = await get('/open-claims-chat?claim=WC-101')
  assert.equal(new URL(expiredEntry.headers.location).searchParams.get('resume'), '/auth/hosted-chat?claim=WC-101')
  const cmsEntry = await get('/open-claims-chat?claim=clm-000020')
  assert.equal(new URL(cmsEntry.headers.location).searchParams.get('resume'), '/auth/hosted-chat?claim=CLM-000020')
  const viewer = '/claims/view-pdf?claimId=WC-101&documentId=WC-101-report&format=pdf'
  assert.equal(new URL((await get(viewer)).headers.location).searchParams.get('resume'), viewer)
  const watched = await get('/desktop/session-watch', { cookie })
  assert.equal(watched.headers['content-type'], 'text/event-stream')
  watched.resume()
  const response = await get('/api', { cookie: cookie + '; unrelated=cookie', authorization: 'ignored' })
  response.resume()
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(relayed.cookie, privateCookie)
  assert.equal(relayed.authorization, undefined)
  assert.equal(relayed.origin, 'http://127.0.0.1:' + native.address().port)
  const socket = new WebSocket('ws://127.0.0.1:' + server.address().port + '/api/remote.mux', {
    headers: { cookie, host: 'localhost:3081', origin: 'http://localhost:3081' },
  })
  await once(socket, 'open')
  const echoed = once(socket, 'message')
  socket.send('synthetic workspace event')
  assert.equal(String((await echoed)[0]), 'synthetic workspace event')
  const ended = Promise.all([once(watched, 'end'), once(socket, 'close')])
  revoke()
  await ended
})
