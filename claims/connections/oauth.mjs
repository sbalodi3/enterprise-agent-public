import { createHash, randomBytes } from 'node:crypto'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { DomainError } from '../domain/index.mjs'

export const appId = 'outlook-mail'
export const callbackPath = '/claims/connections/microsoft/callback'
export const randomValue = () => randomBytes(32).toString('base64url')
export const digest = value => createHash('sha256').update(value).digest('base64url')
const fail = (status, code) => { throw new DomainError(status, code) }
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const graph = 'https://graph.microsoft.com'
const mailScope = 'Mail.Read'

function origin(value, { local = false } = {}) {
  const u = new URL(value)
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))) throw new Error('Invalid Microsoft connection origin')
  return u.origin
}

/** Credentials and immutable workforce-to-Entra bindings are supplied by the deployment. */
export function connectionConfig(env) {
  const { CLAIMS_MS_TENANT_ID: tenant, CLAIMS_MS_CLIENT_ID: clientId, CLAIMS_MS_CLIENT_SECRET: secret,
    CLAIMS_MS_TOKEN_KEY: encodingKey, CLAIMS_MS_ACCOUNT_MAP: assignments, CLAIMS_APP_ORIGIN: application } = env
  if (![tenant, clientId, secret, encodingKey, assignments, application].every(Boolean)) return null
  const emulator = env.CLAIMS_MS_MODE === 'emulator'
  if (env.CLAIMS_MS_MODE && !['live', 'emulator'].includes(env.CLAIMS_MS_MODE)) throw new Error('Invalid Microsoft connection mode')
  const key = Buffer.from(encodingKey, 'base64')
  const accounts = JSON.parse(assignments)
  if (!uuid.test(tenant) || key.length !== 32 || key.toString('base64') !== encodingKey ||
      !accounts || Array.isArray(accounts) || typeof accounts !== 'object' ||
      Object.entries(accounts).some(([principal, oid]) => !/^[^/]+\/[^/]+$/.test(principal) || !uuid.test(oid)) ||
      new Set(Object.values(accounts).map(v => v.toLowerCase())).size !== Object.keys(accounts).length) {
    throw new Error('Invalid Microsoft connection identity or encryption settings')
  }
  const authority = emulator ? origin(env.CLAIMS_MS_AUTHORITY_ORIGIN, { local: true }) : 'https://login.microsoftonline.com'
  const transport = emulator && env.CLAIMS_MS_INTERNAL_ORIGIN ? origin(env.CLAIMS_MS_INTERNAL_ORIGIN, { local: true }) : authority
  const graphOrigin = emulator ? origin(env.CLAIMS_MS_GRAPH_ORIGIN, { local: true }) : graph
  if (!emulator && [env.CLAIMS_MS_GRAPH_ORIGIN, env.CLAIMS_MS_AUTHORITY_ORIGIN, env.CLAIMS_MS_INTERNAL_ORIGIN].some(Boolean))
    throw new Error('Custom Microsoft endpoints require emulator mode')
  const publicOrigin = origin(application, { local: ['localhost','127.0.0.1','[::1]'].includes(new URL(application).hostname) })
  return { tenant: tenant.toLowerCase(), clientId, secret, key, accounts, authority, transport, graphOrigin, mode: emulator ? 'local' : 'live',
    issuer: authority + '/' + tenant.toLowerCase() + '/v2.0', redirect: publicOrigin + callbackPath }
}

export function createMicrosoft(config, request = fetch) {
  let metadata, keys
  function internal(endpoint) {
    const u = new URL(endpoint)
    if (u.origin !== config.authority || u.username || u.password || u.search || u.hash) fail(502, 'microsoft_discovery_invalid')
    return config.transport + u.pathname
  }
  async function fetchJson(url, init = {}) {
    const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) })
    if (!response.ok) fail(503, 'microsoft_service_unavailable')
    return response.json()
  }
  async function discover() {
    if (metadata) return metadata
    const data = await fetchJson(internal(config.issuer + '/.well-known/openid-configuration'))
    if (data.issuer !== config.issuer) fail(502, 'microsoft_discovery_invalid')
    for (const field of ['authorization_endpoint','token_endpoint','jwks_uri']) internal(data[field])
    metadata = data
    return data
  }
  async function tokenRequest(values) {
    const m = await discover()
    const response = await request(internal(m.token_endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ ...values, client_id: config.clientId, client_secret: config.secret }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      if (data.error === 'invalid_grant' || data.error === 'interaction_required') fail(401, 'microsoft_reconnect_required')
      fail(503, 'microsoft_service_unavailable')
    }
    const data = await response.json()
    if (typeof data.access_token !== 'string' || !data.access_token ||
        data.token_type?.toLowerCase() !== 'bearer' || !(Number(data.expires_in) > 0) ||
        !String(data.scope || '').toLowerCase().split(/\s+/).some(s => s === 'mail.read' || s === graph + '/mail.read'))
      fail(403, 'microsoft_mail_scope_required')
    return data
  }
  function tokens(data, previousRefresh) {
    const refresh = data.refresh_token || previousRefresh
    if (typeof refresh !== 'string' || !refresh) fail(401, 'microsoft_reconnect_required')
    return { access: data.access_token, refresh, expires: Date.now() + Number(data.expires_in) * 1000 }
  }
  async function verifyId(raw, nonce, expectedOid) {
    const m = await discover()
    const now = Date.now()
    async function verify(reload) {
      if (!keys || reload || keys.until < now) {
        keys = { keyset: createLocalJWKSet(await fetchJson(internal(m.jwks_uri))), until: now + 3600000 }
      }
      return jwtVerify(raw, keys.keyset, {
        issuer: config.issuer, audience: config.clientId, algorithms: ['RS256'], maxTokenAge: '10m',
        requiredClaims: ['exp','iat','sub','nonce','oid','tid'],
      })
    }
    let payload
    try {
      try { ({ payload } = await verify(false)) }
      catch (error) {
        if (error.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error
        ;({ payload } = await verify(true))
      }
    } catch { fail(403, 'microsoft_identity_invalid') }
    if (payload.nonce !== nonce || typeof payload.oid !== 'string' || payload.oid.toLowerCase() !== expectedOid ||
        typeof payload.tid !== 'string' || payload.tid.toLowerCase() !== config.tenant ||
        (payload.azp !== undefined && payload.azp !== config.clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)) fail(403, 'microsoft_account_mismatch')
    return { accountId: config.tenant + '/' + expectedOid,
      address: typeof payload.preferred_username === 'string' ? payload.preferred_username.slice(0, 320) : null }
  }
  return {
    async authorizationUrl({ state, nonce, verifier }) {
      const m = await discover()
      const url = new URL(m.authorization_endpoint)
      url.search = new URLSearchParams({ response_type: 'code', response_mode: 'query', client_id: config.clientId,
        redirect_uri: config.redirect, scope: 'openid profile offline_access ' + graph + '/' + mailScope, state, nonce,
        code_challenge: digest(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString()
      return url.href
    },
    async exchange(code, flow, expectedOid) {
      const data = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: config.redirect })
      const account = await verifyId(data.id_token, flow.nonce, expectedOid)
      const cache = tokens(data)
      // Confirm that this mailbox is provisioned and the delegated access token can read mail.
      const probe = await request(config.graphOrigin + '/v1.0/me/messages?$top=1&$select=id', {
        headers: { authorization: 'Bearer ' + cache.access }, redirect: 'error', signal: AbortSignal.timeout(8000),
      })
      if (!probe.ok) fail(probe.status === 403 ? 403 : 503, 'microsoft_mailbox_unavailable')
      const page = await probe.json()
      if (!Array.isArray(page.value)) fail(502, 'microsoft_mailbox_unavailable')
      return { ...account, tokens: cache }
    },
    async refresh(cache) {
      const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: cache.refresh })
      return tokens(data, cache.refresh)
    },
  }
}
