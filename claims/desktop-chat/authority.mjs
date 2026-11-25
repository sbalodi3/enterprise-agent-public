import { createServer, request } from 'node:http'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream'
import { isChatBridgeRoute, isWorkbenchBridgeRoute } from './claim-routes.mjs'

export function createChatAuthority(publicOrigin, internalOrigin) {
  const app = new URL(publicOrigin)
  const upstream = new URL(internalOrigin)
  return createServer((req, res) => {
    if (req.headers.host !== app.host || !req.url.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(404).end()
      return
    }
    const destination = URL.parse(req.url, app)
    if (destination?.origin !== app.origin) {
      res.writeHead(404).end()
      return
    }
    const path = destination.pathname
    const sessionRoute = (req.method === 'GET' && ['/auth/me', '/auth/session-watch'].includes(path)) ||
      (req.method === 'POST' && path === '/auth/logout')
    if (!sessionRoute && !isChatBridgeRoute(req.method, path) && !isWorkbenchBridgeRoute(req.method, path)) {
      res.writeHead(404).end()
      return
    }
    const relay = request(upstream, { method: req.method, path: path + destination.search, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode, reply.headers)
      res.flushHeaders()
      pipeline(reply, res, () => {})
    })
    relay.on('error', () => {
      if (res.headersSent) res.destroy()
      else res.writeHead(502).end()
    })
    res.on('close', () => relay.destroy())
    req.pipe(relay)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createChatAuthority(process.env.CLAIMS_APP_ORIGIN, process.env.CLAIMS_CHAT_UPSTREAM)
  server.listen(3080, '0.0.0.0')
}
