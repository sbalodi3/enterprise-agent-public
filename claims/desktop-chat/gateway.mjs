// A workstation companion for the local HTTP demo. Only the shared application
// validates employee sessions. The native owner credential stays in this process.
import http from 'node:http'
import { pipeline, Readable } from 'node:stream'
import { networkInterfaces } from 'node:os'
import { MANAGED_CHAT_PORTS } from './modes.mjs'
import { isChatBridgeRoute, isWorkbenchBridgeRoute } from './claim-routes.mjs'
import { chatTarget, loginHref, resumeDestination } from '../auth/destinations.mjs'
import { directory } from '../auth/roster.mjs'

const authority = new URL(process.env.CLAIMS_APP_ORIGIN || 'http://localhost:3080')
const internalAuthority = new URL(process.env.CLAIMS_CHAT_INTERNAL_ORIGIN || 'http://host.docker.internal:' + (authority.port || '80'))
const app = authority.origin
const sessionName = 'claims_session_dev'
const denied = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'text/plain; charset=utf-8' }

function reject(res, status, message) {
  if (!res.headersSent && !res.destroyed) res.writeHead(status, denied).end(message)
  else res.destroy()
}

function sessionCookie(req) {
  const cookies = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(sessionName + '='))
  return cookies.length === 1 && /^claims_session_dev=[A-Za-z0-9_-]+$/.test(cookies[0]) ? cookies[0] : undefined
}

function unauthenticated(req, res, url, claimEntry) {
  let resume
  if (claimEntry || (url.pathname === '/' && url.search)) {
    const params = url.search || '?claims=1'
    resume = resumeDestination('/auth/hosted-chat' + params)
  } else if (url.pathname === '/claims/view-pdf') {
    resume = resumeDestination(url.pathname + url.search)
  }
  if (req.method === 'GET' && (resume || ['/', '/open-chat'].includes(url.pathname))) {
    const location = app + loginHref(resume)
    if (req.headers['sec-fetch-dest'] === 'iframe' && resume) {
      return res.writeHead(401, { ...denied, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; frame-ancestors 'self'" })
        .end('<p>Your sign-in has ended. <a target="_top" href="' + location + '">Sign in to reopen this PDF</a></p>')
    }
    res.writeHead(303, { ...denied, location }).end()
  } else reject(res, 401, 'Sign in to the application.')
}

// The app checks its public Host even when the managed gateway uses a private route.
function requestAuthority(path, cookie, signal, managed) {
  if (!managed) return fetch(app + path, { headers: { cookie }, signal, redirect: 'error' })
  return new Promise((resolve, reject) => {
    http.get({ hostname: internalAuthority.hostname, port: Number(internalAuthority.port || 80), path, headers: { host: authority.host, cookie }, signal }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve(new Response(null, { status: [401, 403].includes(res.statusCode) ? res.statusCode : 503 }))
        return
      }
      resolve(new Response(Readable.toWeb(res), { headers: { 'content-type': res.headers['content-type'] || '' } }))
    }).on('error', reject)
  })
}

// One live subscription per active application session. The primary app ends it
// on logout, expiry or provider failure. An existing native stream then closes
// even if the client never sends another request.
function watchSession(cookie, managed, onEnd) {
  const control = new AbortController()
  const timeout = setTimeout(() => control.abort(), 5000)
  const listeners = new Set()
  const watch = {
    listeners, close: () => control.abort(),
    ready: requestAuthority('/auth/session-watch', cookie, control.signal, managed).then(response => {
      clearTimeout(timeout)
      if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'text/event-stream') {
        control.abort()
        throw new Error('Session subscription unavailable')
      }
      const read = async () => {
        for await (const _ of response.body) { /* Discard keepalives. */ }
      }
      void read().catch(() => {}).finally(() => {
        onEnd()
        for (const end of listeners) end()
      })
    }).catch(error => {
      clearTimeout(timeout)
      onEnd()
      throw error
    }),
  }
  return watch
}

const requestHeaders = ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'last-event-id']
const responseHeaders = [
  'content-type', 'content-length', 'content-encoding', 'content-disposition', 'content-range',
  'accept-ranges', 'content-security-policy', 'x-content-type-options',
]

function relay(req, res, path, upstream, credential, claimsBridge = false, managed = false) {
  const headers = { cookie: credential, origin: upstream.origin, 'sec-fetch-site': 'same-origin' }
  for (const key of requestHeaders) if (req.headers[key] !== undefined) headers[key] = req.headers[key]
  if (claimsBridge) {
    headers.host = upstream.host
    if (req.headers['x-csrf-token']) headers['x-csrf-token'] = req.headers['x-csrf-token']
  }
  const destination = claimsBridge && managed ? internalAuthority : upstream
  const proxy = http.request({ hostname: destination.hostname, port: destination.port, method: req.method, path, headers }, reply => {
    // The native API uses relative paths. Never deliver an owner redirect or
    // cookie (or an absolute URL identifying the private native port).
    if (reply.statusCode >= 300 && reply.statusCode < 400) {
      reply.resume()
      reject(res, 502, 'Desktop chat returned an unexpected redirect.')
      return
    }
    const outgoing = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': claimsBridge && path.startsWith('/claims/view-pdf?') ? 'SAMEORIGIN' : 'DENY' }
    for (const key of responseHeaders) if (reply.headers[key] !== undefined) outgoing[key] = reply.headers[key]
    res.writeHead(reply.statusCode, outgoing)
    res.flushHeaders()
    pipeline(reply, res, () => {})
  })
  proxy.on('error', () => reject(res, 502, 'Desktop chat is unavailable.'))
  res.once('close', () => proxy.destroy())
  req.pipe(proxy)
}

export async function pairPrivateChat(launchUrl, publicPort) {
  const upstream = new URL(launchUrl)
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || !upstream.port ||
      Number(upstream.port) === publicPort || upstream.username || upstream.password || upstream.pathname !== '/' ||
      !upstream.searchParams.get('token')) {
    throw new Error('Invalid desktop launch configuration')
  }
  const paired = await fetch(upstream, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const credential = paired.headers.getSetCookie().map(cookie => cookie.split(';')[0]).find(cookie => /^dsh-auth-[A-Za-z0-9_-]+=/.test(cookie))
  await paired.body?.cancel()
  if (paired.status !== 303 || !credential) throw new Error('Could not initialize private desktop session')
  upstream.search = ''
  return { upstream, credential }
}

export async function startDesktopGateway({ launchUrl, user, managedPort, acquireNative }) {
  const managed = managedPort !== undefined
  if (!user?.subject || !user.tenantId || !user.principalId || (managed && MANAGED_CHAT_PORTS[user.principalId] !== managedPort))
    throw new Error('Invalid managed chat assignment')
  const port = managedPort ?? Number(authority.port || 80) + 1
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid companion port')
  const chat = new URL('http://' + authority.hostname + ':' + port)
  const bind = managed ? Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && !n.internal)?.address : '127.0.0.1'
  if (!bind) throw new Error('No private interface for the managed chat gateway')
  const fixedNative = acquireNative ? undefined : await pairPrivateChat(launchUrl, port)
  async function nativeFor(destination) {
    if (fixedNative) return fixedNative
    const native = await acquireNative()
    if (destination.destroyed || destination.writableEnded) { native.release(); return }
    destination.once('close', native.release)
    return native
  }
  const watchers = new Map()
  async function identityOf(cookie) {
    if (!cookie) return { status: 401 }
    const me = await requestAuthority('/auth/me', cookie, AbortSignal.timeout(5000), managed)
    if (!me.ok) {
      await me.body?.cancel()
      return { status: [401, 403].includes(me.status) ? me.status : 503 }
    }
    return { status: 200, identity: (await me.json()).user }
  }
  function assigned(identity) {
    return identity?.subject === user.subject && identity.tenantId === user.tenantId && identity.principalId === user.principalId
  }
  async function monitor(cookie, destination, revoke) {
    let watch = watchers.get(cookie)
    if (!watch) {
      watch = watchSession(cookie, managed, () => { if (watchers.get(cookie) === watch) watchers.delete(cookie) })
      watchers.set(cookie, watch)
    }
    watch.listeners.add(revoke)
    destination.once('close', () => {
      watch.listeners.delete(revoke)
      if (watch.listeners.size === 0 && watchers.get(cookie) === watch) {
        watchers.delete(cookie)
        watch.close()
      }
    })
    await watch.ready
  }
  async function handle(req, res) {
    if (req.headers.host !== chat.host || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
      return reject(res, 403, 'Forbidden.')
    }
    const url = new URL(req.url, chat)
    const typedQuery = !url.search ? '' : chatTarget(url.searchParams)?.split('?')[1]
    const claimEntry = req.method === 'GET' && url.pathname === '/open-claims-chat' && typedQuery !== undefined
    if (url.pathname === '/open-claims-chat' && !claimEntry) return reject(res, 400, 'Invalid Claims Agent destination.')
    const entry = (req.method === 'GET' && url.pathname === '/open-chat' && !url.search) || claimEntry
    if (!managed && req.url === '/desktop/presence' && req.method === 'GET' && req.headers.origin === app && !req.headers.cookie && !req.headers.authorization) {
      res.writeHead(204, { 'access-control-allow-origin': app, 'cache-control': 'no-store', vary: 'Origin' }).end()
      return
    }
    const site = req.headers['sec-fetch-site']
    const origin = req.headers.origin
    const handoff = entry && site === 'same-site' && req.headers['sec-fetch-mode'] === 'navigate' &&
      req.headers['sec-fetch-dest'] === 'document' && (!origin || origin === app)
    if (!handoff && ((origin && origin !== chat.origin) || (site && site !== 'same-origin' && site !== 'none'))) {
      return reject(res, 403, 'Forbidden.')
    }
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) ||
        (!['GET', 'HEAD'].includes(req.method) && origin !== chat.origin) ||
        url.origin !== chat.origin || url.pathname === '/connect' || url.pathname.startsWith('/connect/') ||
        url.searchParams.has('token') || /^\/auth(?:\/|$)/.test(url.pathname)) return reject(res, 403, 'Forbidden.')
    if (['/desktop/workbench/login', '/desktop/workbench/signed-out'].includes(url.pathname) && req.method === 'GET') {
      res.writeHead(303, { ...denied, location: app + '/auth/' + url.pathname.split('/').pop() }).end()
      return
    }
    if (url.pathname === '/desktop/open-app' || url.pathname === '/desktop/open-workbench' || url.pathname === '/desktop/open-claims-chat') {
      if (req.method !== 'GET') return reject(res, 405, 'Method not allowed.')
      const target = url.pathname === '/desktop/open-claims-chat' ? '/auth/hosted-chat?claims=1' : url.pathname.slice('/desktop'.length)
      res.writeHead(303, { ...denied, location: app + target }).end()
      return
    }
    const cookie = sessionCookie(req)
    const { status, identity } = await identityOf(cookie)
    if (status === 401) return unauthenticated(req, res, url, claimEntry)
    if (status !== 200) return reject(res, status, 'Unable to verify the application session.')
    if (!assigned(identity)) {
      // A click may hand off to another employee's container. No native request
      // or credential crosses this assignment boundary.
      const other = directory(true, true).employees.find(employee => employee.profile === 'claims-v1' && employee.subject === identity?.subject &&
        employee.tenantId === identity.tenantId && employee.principalId === identity.principalId)
      if (!managed && entry && other) {
        const port = MANAGED_CHAT_PORTS[other.principalId]
        const location = port
          ? 'http://' + authority.hostname + ':' + port + url.pathname + url.search
          : app + '/auth/hosted-chat' + (claimEntry ? (url.search || '?claims=1') : '')
        res.writeHead(303, { ...denied, location }).end()
      } else reject(res, 403, 'This chat belongs to another employee.')
      return
    }
    if (entry) {
      const target = claimEntry ? '/' + (typedQuery ? '?' + typedQuery : '') + '#claim-chat' : '/#new-desktop-session'
      res.writeHead(200, { ...denied, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" })
      res.end('<!doctype html><title>Opening chat</title><meta http-equiv="refresh" content="0;url=' + target + '"><a href="' + target + '">Open chat</a>')
      return
    }
    // Logout itself ends the session watch. Let the authority finish its response.
    if (url.pathname === '/desktop/workbench/logout' && req.method === 'POST') {
      return relay(req, res, '/auth/logout', authority, cookie, true, managed)
    }
    if (res.destroyed) return
    await monitor(cookie, res, () => {
      if (url.pathname === '/desktop/session-watch' && res.headersSent) res.end()
      else reject(res, 401, 'Your application session has ended.')
    })
    if (res.destroyed || res.writableEnded) return
    if (url.pathname === '/desktop/session-watch') {
      if (req.method !== 'GET') return reject(res, 405, 'Method not allowed.')
      res.writeHead(200, { ...denied, 'content-type': 'text/event-stream' })
      res.write(': application session active\n\n')
      return
    }
    if (url.pathname === '/desktop/workbench/me' && req.method === 'GET') {
      return relay(req, res, '/auth/me', authority, cookie, true, managed)
    }
    if (url.pathname.startsWith('/desktop/workbench/')) return reject(res, 404, 'Not found.')
    if (url.pathname.startsWith('/claims/')) {
      if (!isChatBridgeRoute(req.method, url.pathname) && !isWorkbenchBridgeRoute(req.method, url.pathname)) return reject(res, 404, 'Not found.')
      return relay(req, res, url.pathname + url.search, authority, cookie, true, managed)
    }
    const native = await nativeFor(res)
    if (native) relay(req, res, url.pathname + url.search, native.upstream, native.credential)
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => reject(res, 503, 'Unable to verify the application session.'))
  })
  // The stock web client multiplexes workspace/session events on this single
  // socket. It requires the same identity and lifetime as each HTTP request.
  const upgraded = new Set()
  server.on('connect', (_req, socket) => socket.destroy())
  server.on('upgrade', (req, client, head) => {
    client.on('error', () => client.destroy())
    if (req.method !== 'GET' || req.url !== '/api/remote.mux' || req.headers.host !== chat.host ||
        req.headers.origin !== chat.origin || req.headers['sec-fetch-site'] === 'cross-site' ||
        req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] || '')) {
      client.destroy()
      return
    }
    upgraded.add(client)
    client.once('close', () => upgraded.delete(client))
    async function connect() {
      const cookie = sessionCookie(req)
      const { status, identity } = await identityOf(cookie)
      if (status !== 200 || !assigned(identity) || client.destroyed) return client.destroy()
      await monitor(cookie, client, () => client.destroy())
      if (client.destroyed) return
      const native = await nativeFor(client)
      if (!native) return
      const { upstream, credential } = native
      const proxy = http.request({
        hostname: upstream.hostname, port: upstream.port, path: req.url,
        headers: { connection: 'Upgrade', upgrade: 'websocket', origin: upstream.origin, cookie: credential,
          'sec-websocket-version': '13', 'sec-websocket-key': req.headers['sec-websocket-key'] },
      })
      client.once('close', () => proxy.destroy())
      proxy.once('error', () => client.destroy())
      proxy.once('response', reply => { reply.destroy(); client.destroy() })
      proxy.once('upgrade', (reply, remote, remoteHead) => {
        remote.on('error', () => client.destroy())
        client.once('close', () => remote.destroy())
        remote.once('close', () => client.destroy())
        if (client.destroyed || reply.statusCode !== 101 || !reply.headers['sec-websocket-accept']) {
          remote.destroy()
          client.destroy()
          return
        }
        client.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + reply.headers['sec-websocket-accept'] + '\r\n\r\n')
        if (remoteHead.length) client.write(remoteHead)
        if (head.length) remote.write(head)
        client.pipe(remote).pipe(client)
      })
      proxy.end()
    }
    void connect().catch(() => client.destroy())
  })
  const closeHTTP = server.closeAllConnections.bind(server)
  server.closeAllConnections = () => { closeHTTP(); for (const socket of upgraded) socket.destroy() }
  server.on('close', () => { for (const watch of watchers.values()) watch.close() })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(chat.port), bind, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}
