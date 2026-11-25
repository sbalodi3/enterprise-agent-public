import { readFileSync } from 'node:fs'
import { DomainError } from '../domain/index.mjs'
import { appId, callbackPath, connectionConfig, createMicrosoft, randomValue } from './oauth.mjs'
import { createConnectionStore } from './store.mjs'
import { createOperationGate, outlookOperations } from './operations.mjs'

const apiPath = '/claims/api/connections'
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

function json(res, status, value) {
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
}

function finish(res, status, text) {
  const nonce = randomValue()
  const close = status === 200 ? 'window.close()' :
    "document.getElementById('close').addEventListener('click', () => window.close())"
  res.writeHead(status, { ...headers, 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  }).end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Outlook connection</title><main><h1>Microsoft Outlook</h1><p>${text}</p><p>You can close this window and return to App connections.</p>${status === 200 ? '' : '<button id="close">Close</button>'}</main><script nonce="${nonce}">history.replaceState(null,'',location.pathname);${close}</script></html>`)
}

export function createConnections({ pool, auth, env = process.env, fetch = globalThis.fetch }) {
  if (env.CLAIMS_LOCAL_OUTLOOK_CONFIG) {
    // The local provider publishes a new, atomic account map whenever it reseeds.
    let previous, service
    const active = () => {
      const raw = readFileSync(env.CLAIMS_LOCAL_OUTLOOK_CONFIG, 'utf8')
      if (raw !== previous) {
        const settings = JSON.parse(raw)
        service = createConnections({ pool, auth, fetch, env: { ...settings, CLAIMS_APP_ORIGIN: env.CLAIMS_APP_ORIGIN, CLAIMS_MS_MODE: 'emulator' } })
        previous = raw
      }
      return service
    }
    const methods = ['status', 'withAccess', 'commitIfCurrent', 'withOperation']
    return { ...Object.fromEntries(methods.map(key => [key, (...args) => active()[key](...args)])),
      handle(req, res) {
        const path = new URL(req.url, 'http://localhost').pathname
        return path === callbackPath || path === apiPath || path.startsWith(apiPath + '/') ? active().handle(req, res) : false
      } }
  }
  const config = connectionConfig(env)
  const store = createConnectionStore({ pool, config, microsoft: config && createMicrosoft(config, fetch) })
  const run = createOperationGate({ operations: outlookOperations, status: store.status, withAccess: store.withAccess })
  const actions = new Map([['connect', (p, req) => store.begin(p, auth.browserCsrf(req))], ['disconnect', p => store.disconnect(p)]])
  return {
    status: store.status, withAccess: store.withAccess, commitIfCurrent: store.commitIfCurrent,
    withOperation: run,
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname !== callbackPath && url.pathname !== apiPath && !url.pathname.startsWith(apiPath + '/')) return false
      const callback = url.pathname === callbackPath
      try {
        if (callback) {
          const session = auth.microsoftCallbackSession(req)
          await store.complete(session.principal, session.binding, url.searchParams, () => auth.microsoftCallbackSession(req))
          finish(res, 200, 'Your Outlook mailbox is connected.')
        } else if (req.method === 'GET' && url.pathname === apiPath) {
          const app = await store.status(auth.require(req))
          json(res, 200, { apps: [app], csrfToken: auth.browserCsrf(req) })
        } else {
          const [name, action, ...extra] = url.pathname.slice(apiPath.length + 1).split('/')
          if (name !== appId || !actions.has(action) || extra.length) throw new DomainError(404, 'connection_route_unknown')
          if (req.method !== 'POST') throw new DomainError(405, 'method_not_allowed')
          const p = auth.require(req, { write: true })
          const result = await actions.get(action)(p, req)
          auth.require(req)
          json(res, 200, result)
        }
      } catch (error) {
        const known = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        const status = known ? error.status : 503
        const code = known && /^[a-z0-9_]+$/i.test(error.code || '') ? error.code : 'microsoft_connection_unavailable'
        if (callback) {
          const text = code === 'microsoft_consent_declined' ? 'The connection was cancelled.' :
            code === 'microsoft_account_mismatch' ? 'Choose the Microsoft account assigned to your employee profile.' :
            'The connection could not be verified. Return to App connections and try again.'
          finish(res, status, text)
        } else json(res, status, { code })
      }
      return true
    },
  }
}
