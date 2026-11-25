import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { managedChatPorts } from '../desktop-chat/modes.mjs'

const script = await readFile(new URL('../ui/widget-proxy.js', import.meta.url), 'utf8')

function browserOrigin(value) {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) || url.hostname.endsWith('.localhost')
  if (url.origin !== value || !(url.protocol === 'https:' || local && url.protocol === 'http:'))
    throw Error('Invalid claims widget browser origin')
  return url
}
export function widgetSettings(env) {
  if (env.CLAIMS_WIDGETS_DISABLED === '1' || !env.CLAIMS_WIDGET_ORIGIN) return null
  const sandbox = browserOrigin(env.CLAIMS_WIDGET_ORIGIN)
  const app = browserOrigin(env.CLAIMS_APP_ORIGIN || 'http://localhost:3080')
  const parents = new Set([app.origin])
  if (env.CLAIMS_WIDGET_PARENT_ORIGINS) {
    for (const value of env.CLAIMS_WIDGET_PARENT_ORIGINS.split(',')) parents.add(browserOrigin(value.trim()).origin)
  } else if (app.protocol === 'http:') {
    const ports = managedChatPorts(Number(env.CLAIMS_CHAT_PORT_BASE || 3083), env.CLAIMS_CMS_MCP === '1')
    for (const port of [Number(app.port) + 1, ...Object.values(ports)]) parents.add(app.protocol + '//' + app.hostname + ':' + port)
  }
  if ([...parents].some(value => new URL(value).hostname === sandbox.hostname))
    throw Error('The widget sandbox requires a separate hostname')
  return { origin: sandbox.origin, parents }
}
// An unusable listener leaves the employee application in text mode. Publish the origin
// only after this process owns the listening socket.
export async function startConfiguredWidgetSandbox(env, warn = console.warn) {
  try {
    const settings = widgetSettings(env)
    if (!settings) return null
    const server = await startWidgetSandbox(settings, Number(env.CLAIMS_WIDGET_LISTEN_PORT || 3098),
      env.CLAIMS_WIDGET_BIND || '127.0.0.1')
    return { origin: settings.origin, server }
  } catch {
    warn('Claims widget sandbox unavailable. Check the configured origins and listener. Text views are active.')
    return null
  }
}
export async function startWidgetSandbox(settings, port, address) {
  const server = createServer((req, res) => {
    let url
    try { url = new URL(req.url, settings.origin) } catch { return res.writeHead(400).end() }
    const parent = url.searchParams.get('parent')
    if (req.method !== 'GET' || req.headers.host !== new URL(settings.origin).host ||
        url.pathname !== '/proxy' || !settings.parents.has(parent))
      return res.writeHead(404).end()
    const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " + parent
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp,
      'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-write=()' })
    res.end('<!doctype html><html lang="en"><title>Claims widget sandbox</title><style>html,body,iframe{width:100%;height:100%;border:0;margin:0;display:block}</style><body><script>' + script + '</script></body></html>')
  })
  server.listen(port, address)
  await once(server, 'listening')
  return server
}
