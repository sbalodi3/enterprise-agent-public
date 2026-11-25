import { setTimeout as delay } from 'node:timers/promises'
import { OidcBrowserSessions, ClaimsAuthError } from './sessions.mjs'
import { employeeResolver } from './identity-links.mjs'
import { directory } from './roster.mjs'
import { configFromEnvironment } from './config.mjs'

export const name = 'claims-browser-auth'
export const inject = ['claimsDatabase', 'connection', 'webServer', 'remoteAccess']
export { configFromEnvironment, ClaimsAuthError }

// A rootless VM can restart the application while the directory is still opening its store.
export async function initializeDirectory(auth, signal, wait = delay) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { await auth.initialize(); return }
    catch (error) {
      const cause = error.cause
      const transient = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(cause?.cause?.code) ||
        cause?.name === 'TimeoutError' || [502, 503, 504].includes(cause?.status)
      if (!transient || attempt >= 12) throw error
      await wait(Math.min(500 * 2 ** attempt, 5000), undefined, { signal })
    }
  }
}

/** Mount OIDC browser sessions without adding any owner-level harness grant. */
export async function apply(ctx, supplied) {
  const config = supplied && Object.keys(supplied).length ? supplied : configFromEnvironment()
  const auth = new OidcBrowserSessions(config, {
    resolveEmployee: employeeResolver(ctx.claimsDatabase, directory(process.env.CLAIMS_SHOWCASE === '1')),
    createPeer: principal => ctx.connection.createPeer({ principal, interactions: 'answer' }),
  })
  const startup = new AbortController()
  ctx.effect(() => () => startup.abort(), 'claims-auth: cancel discovery on shutdown')
  await initializeDirectory(auth, startup.signal)
  ctx.effect(() => () => auth.dispose(), 'claims-auth: browser sessions')
  ctx.connection.registerAdmissionProvider(auth)
  // Shared Chat installs employee bindings. The legacy Workbench grants only domain API access.
  if (!config.sharedChat) ctx.remoteAccess.registerPolicy('claims-user', { bindings: () => [] })
  ctx.provide('claimsAuth', auth)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/auth',
    handler: async (req, res) => {
      if (req.url === '/auth/session-watch' && req.method === 'GET') {
        const admission = auth.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection, { 'cache-control': 'no-store' }).end()
          return
        }
        // The desktop gateway closes its own channels when this session ends.
        const { signal } = admission.peer
        res.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/event-stream',
          'x-accel-buffering': 'no',
        })
        res.flushHeaders()
        const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30_000)
        keepalive.unref()
        const end = () => res.end()
        signal.addEventListener('abort', end, { once: true })
        res.once('close', () => {
          clearInterval(keepalive)
          signal.removeEventListener('abort', end)
        })
        if (signal.aborted) end()
        return
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
        else if (value) for (const item of value) headers.append(key, item)
      }
      let body
      if (req.method === 'POST') {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 16384) {
            res.writeHead(413, { 'cache-control': 'no-store' })
            res.end('Authentication request is too large.')
            return
          }
          chunks.push(chunk)
        }
        body = Buffer.concat(chunks)
      }
      const request = new Request(new URL(req.url, config.appOrigin), { method: req.method, headers, ...(body === undefined ? {} : { body }) })
      const response = await auth.handle(request)
      const responseHeaders = Object.fromEntries(response.headers)
      const cookies = response.headers.getSetCookie()
      if (cookies.length) responseHeaders['set-cookie'] = cookies
      res.writeHead(response.status, responseHeaders)
      res.end(await response.text())
    },
  }), 'claims-auth: HTTP routes')
}
