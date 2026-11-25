import { createServer } from 'node:http'
import { chatTarget, loginHref, standardChatId } from '../auth/destinations.mjs'
const origin = new URL(process.env.CLAIMS_APP_ORIGIN)
createServer((req, res) => {
  const url = new URL(req.url, origin)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405).end(); return }
  let target = '/chat'
  if (url.pathname === '/claims/view-pdf') target = url.pathname + url.search
  else if (['/', '/chat', '/open-chat', '/open-claims-chat'].includes(url.pathname) && (chatTarget(url.searchParams) || standardChatId(url.searchParams)))
    target += url.search || (url.pathname === '/open-claims-chat' ? '?claims=1' : '')
  else { res.writeHead(404).end(); return }
  res.writeHead(303, { location: new URL(loginHref(target), origin).href }).end()
}).listen(8080, '0.0.0.0')
