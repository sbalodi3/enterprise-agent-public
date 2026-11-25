import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { createChatAuthority } from '../desktop-chat/authority.mjs'

test('the private relay preserves the public authority and streams only employee routes', async t => {
  const app = 'http://localhost:3080'
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers.host, 'localhost:3080')
    assert.equal(req.headers.cookie, 'claims_session_dev=synthetic')
    if (req.url === '/auth/session-watch') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).write(': active\n\n')
      return
    }
    assert.equal(req.url, '/claims/api/chat/route?fixture=1')
    assert.equal(req.headers.origin, app)
    assert.equal(req.headers['x-csrf-token'], 'synthetic')
    let body = ''
    for await (const chunk of req) body += chunk
    res.end(body)
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const relay = createChatAuthority(app, 'http://127.0.0.1:' + upstream.address().port)
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  t.after(() => {
    relay.close()
    relay.closeAllConnections()
    upstream.close()
    upstream.closeAllConnections()
  })

  function send(path, { method = 'GET', host = 'localhost:3080', body } = {}) {
    return new Promise((resolve, reject) => {
      const client = request({
        hostname: '127.0.0.1', port: relay.address().port, path, method,
        headers: { host, cookie: 'claims_session_dev=synthetic', origin: app, 'x-csrf-token': 'synthetic' },
      }, resolve)
      client.on('error', reject)
      client.end(body)
    })
  }

  const stream = await send('/auth/session-watch')
  assert.equal(stream.headers['content-type'], 'text/event-stream')
  const [chunk] = await once(stream, 'data')
  assert.equal(chunk.toString(), ': active\n\n')
  stream.destroy()

  const response = await send('/claims/api/chat/route?fixture=1', { method: 'POST', body: '{"question":"synthetic"}' })
  let body = ''
  for await (const chunk of response) body += chunk
  assert.equal(body, '{"question":"synthetic"}')
  for (const path of ['/api/internal/work/wage/pending', '//other.test/auth/me', '/claims/api/chat/route']) {
    const denied = await send(path)
    assert.equal(denied.statusCode, 404)
    denied.resume()
  }
  const wrongHost = await send('/auth/me', { host: 'other.test' })
  assert.equal(wrongHost.statusCode, 404)
  wrongHost.resume()
})
