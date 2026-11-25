import { MANAGED_CHAT_PORTS } from '../desktop-chat/modes.mjs'
import { chatTarget, loginHref, resumeDestination } from './destinations.mjs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { HarnessError } from '@deepseek-ai/dsh-error'

/** Authentication failures expose safe codes, never provider responses or token contents. */
export class ClaimsAuthError extends HarnessError {
  constructor(status, code, message, options) {
    super(message, code, options)
    this.status = status
  }
}

const fail = (status, code, message) => { throw new ClaimsAuthError(status, code, message) }
const random = () => randomBytes(32).toString('base64url')
const equal = (left, right) => typeof left === 'string' && typeof right === 'string'
  && Buffer.byteLength(left) === Buffer.byteLength(right)
  && timingSafeEqual(Buffer.from(left), Buffer.from(right))

/** Read a single header from Fetch or Node requests. Ambiguous values are refused. */
export function header(request, key) {
  const value = request.headers instanceof Headers ? request.headers.get(key) : request.headers[key.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

function cookie(request, name) {
  const values = (header(request, 'cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined
}

function url(value, originOnly = false) {
  const result = new URL(value)
  if (result.username || result.password || result.search || result.hash
    || (originOnly && result.pathname !== '/')
    || !['http:', 'https:'].includes(result.protocol)) throw new TypeError('Invalid OIDC deployment URL')
  return result
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

/** OIDC code + PKCE login; only opaque browser credentials leave this server. */
export class OidcBrowserSessions {
  #sessions = new Map()
  #flows = new Map()
  #logoutIds = new Map()
  #revokedSessions = new Map()
  #revokedSubjects = new Map()
  #closed = false
  #tokenEndpoint
  #metadata
  #keys
  #resolveEmployee
  #createPeer
  #now
  #fetch

  constructor(config, { createPeer, resolveEmployee, now = Date.now, fetch = globalThis.fetch } = {}) {
    this.config = { ...config }
    this.origin = url(config.appOrigin, true)
    this.issuer = url(config.issuer)
    this.internalOrigin = config.internalOrigin ? url(config.internalOrigin, true) : undefined
    for (const endpoint of [this.origin, this.issuer]) {
      if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
        throw new TypeError('Public OIDC URLs require HTTPS except on loopback')
      }
    }
    for (const key of ['sessionSeconds', 'flowSeconds', 'requestTimeoutMs', 'maxSessions']) positive(config[key], key)
    if (!config.clientId || typeof config.clientSecret !== 'string' || config.clientSecret.length < 16) throw new TypeError('A client ID and confidential client secret are required')
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.tenant)
      || this.issuer.pathname !== '/' + config.tenant + '/v2.0') throw new TypeError('Expected the configured Entra tenant issuer')
    if (typeof resolveEmployee !== 'function') throw new TypeError('An employee resolver is required')
    this.#resolveEmployee = resolveEmployee
    this.cookieName = this.origin.protocol === 'https:' ? '__Host-claims_session' : 'claims_session_dev'
    this.flowCookieName = this.origin.protocol === 'https:' ? '__Host-claims_login' : 'claims_login_dev'
    this.#createPeer = createPeer
    this.#now = now
    this.#fetch = fetch
  }

  /** Resolve only configured issuer endpoints; internal routing never changes the verified issuer. */
  #internal(value, path) {
    const endpoint = url(value)
    if (endpoint.href !== this.issuer.origin + path) throw new TypeError('Unexpected Entra discovery endpoint')
    return this.internalOrigin ? new URL(path, this.internalOrigin).href : endpoint.href
  }

  async initialize() {
    try {
      const base = '/' + this.config.tenant
      const discovery = this.issuer.pathname + '/.well-known/openid-configuration'
      const response = await this.#fetch(this.#internal(this.issuer.origin + discovery, discovery), {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs), redirect: 'error',
      })
      if (!response.ok) throw Object.assign(new Error('discovery unavailable'), { status: response.status })
      const metadata = await response.json()
      if (metadata.issuer !== this.config.issuer) throw new Error('issuer mismatch')
      this.#internal(metadata.authorization_endpoint, base + '/oauth2/v2.0/authorize')
      this.#tokenEndpoint = this.#internal(metadata.token_endpoint, base + '/oauth2/v2.0/token')
      const keys = this.#internal(metadata.jwks_uri, base + '/discovery/v2.0/keys')
      this.#metadata = metadata
      this.#keys = createRemoteJWKSet(new URL(keys), { timeoutDuration: this.config.requestTimeoutMs })
    } catch (cause) {
      throw new ClaimsAuthError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Sign-in is unavailable. Try again later.', { cause })
    }
  }

  /** Same-authority admission is also enforced for routes outside the harness Gateway. */
  #trust(request, write = false) {
    if (header(request, 'host') !== this.origin.host) fail(403, 'AUTH_ORIGIN_DENIED', 'Request origin is not permitted.')
    const origin = header(request, 'origin')
    if ((origin !== undefined && origin !== this.origin.origin) || (write && origin !== this.origin.origin)
      || header(request, 'sec-fetch-site') === 'cross-site') fail(403, 'AUTH_ORIGIN_DENIED', 'Request origin is not permitted.')
  }

  #cookie(name, value, seconds) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.origin.protocol === 'https:' ? '; Secure' : ''}`
  }

  #response(status, body, extra = {}) {
    return new Response(body === null ? null : JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...extra },
    })
  }

  #callbackRetry(status) {
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in again · Enterprise Agent</title><main><h1>Sign in again</h1><p>This sign-in expired or could not be verified.</p><a href="/auth/login">Start a new sign-in</a></main></html>`, {
      status, headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      },
    })
  }

  #live(request) {
    if (this.#closed) fail(401, 'AUTH_REQUIRED', 'Sign in to continue.')
    const id = cookie(request, this.cookieName)
    const session = id ? this.#sessions.get(id) : undefined
    if (!session || session.expiresAt <= this.#now() || session.peer.signal.aborted) {
      if (session) void this.#remove(id)
      fail(401, 'AUTH_REQUIRED', 'Sign in to continue.')
    }
    return session
  }

  /** Return verified identity; mutations additionally require a session-bound CSRF token. */
  require(request, { write = false } = {}) {
    this.#trust(request, write)
    const session = this.#live(request)
    if (write && !equal(header(request, 'x-csrf-token'), session.csrfToken)) fail(403, 'AUTH_CSRF_DENIED', 'Refresh this page before trying again.')
    return session.peer.principal
  }

  browserCsrf(request) {
    this.require(request)
    return this.#live(request).csrfToken
  }

  /** The provider returns via cross-site top-level GET. The connection handler also
   * verifies a single-use state bound to this exact live application session. */
  microsoftCallbackSession(request) {
    if (request.method !== 'GET' || header(request, 'host') !== this.origin.host ||
        new URL(request.url, this.origin).pathname !== '/claims/connections/microsoft/callback') {
      fail(403, 'AUTH_ORIGIN_DENIED', 'Invalid account connection callback.')
    }
    const session = this.#live(request)
    return { principal: session.peer.principal, binding: session.csrfToken }
  }

  /** The native harness resolves the same identity, never its default owner. */
  admit(request) {
    try {
      this.require(request)
      return { peer: this.#live(request).peer }
    } catch (error) {
      if (error instanceof ClaimsAuthError) return { rejection: error.status === 403 ? 403 : 401 }
      throw error
    }
  }

  authorizeIndex(request, response) {
    const admission = this.admit(request)
    if ('peer' in admission) return true
    const requested = new URL(request.url, this.origin).searchParams.get('mode')
    const login = ['workbench','companion'].includes(requested) ? '/auth/login?mode='+requested : '/auth/login'
    response.writeHead(admission.rejection === 401 ? 303 : 403, { location: login, 'cache-control': 'no-store' })
    response.end(admission.rejection === 401 ? '' : 'forbidden')
    return false
  }

  async #remove(id) {
    const session = this.#sessions.get(id)
    if (!session) return
    this.#sessions.delete(id)
    clearTimeout(session.timer)
    await session.peer.dispose()
  }

  #prune() {
    for (const [state, flow] of this.#flows) if (flow.expiresAt <= this.#now()) this.#flows.delete(state)
    for (const [id, expiry] of this.#logoutIds) if (expiry <= this.#now()) this.#logoutIds.delete(id)
    for (const [id, expiry] of this.#revokedSessions) if (expiry <= this.#now()) this.#revokedSessions.delete(id)
    for (const [id, entry] of this.#revokedSubjects) if (entry.expiresAt <= this.#now()) this.#revokedSubjects.delete(id)
  }

  #login(request) {
    this.#trust(request)
    this.#prune()
    if (this.#closed || !this.#metadata) fail(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Sign-in is unavailable.')
    if (this.#flows.size >= this.config.maxSessions || this.#sessions.size >= this.config.maxSessions) fail(503, 'AUTH_CAPACITY', 'Sign-in is busy. Try again later.')
    const state = random(), verifier = random(), nonce = random(), browser = random()
    const params = new URL(request.url).searchParams
    const resume = resumeDestination(params.get('resume')) || (params.get('mode') === 'companion' ? '/?mode=companion' : params.get('mode') === 'workbench' ? '/?mode=workbench#workbench' : '/')
    this.#flows.set(state, { verifier, nonce, browser, resume, expiresAt: this.#now() + this.config.flowSeconds * 1000 })
    const destination = new URL(this.#metadata.authorization_endpoint)
    destination.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: `${this.origin.origin}/auth/callback`, response_type: 'code',
      scope: 'openid profile', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', prompt: 'select_account',
    }).toString()
    return this.#response(303, null, { location: destination.href, 'set-cookie': this.#cookie(this.flowCookieName, browser, this.config.flowSeconds) })
  }

  async #callback(request) {
    // Cross-site top-level GET is expected from the IdP; state and its HttpOnly browser binding authenticate this return.
    if (header(request, 'host') !== this.origin.host) fail(403, 'AUTH_ORIGIN_DENIED', 'Request origin is not permitted.')
    const params = new URL(request.url).searchParams
    const state = params.get('state'), code = params.get('code')
    const flow = state ? this.#flows.get(state) : undefined
    if (!flow || params.getAll('state').length !== 1 || params.getAll('code').length !== 1 || !code
      || code.length > 8192 || flow.expiresAt <= this.#now() || !equal(cookie(request, this.flowCookieName), flow.browser)) {
      fail(400, 'AUTH_CALLBACK_INVALID', 'Sign-in expired or could not be verified. Start sign-in again.')
    }
    this.#flows.delete(state)
    if (params.has('iss') && params.get('iss') !== this.config.issuer) fail(400, 'AUTH_CALLBACK_INVALID', 'Sign-in issuer did not match.')
    let payload
    try {
      const response = await this.#fetch(this.#tokenEndpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.config.clientId,
          client_secret: this.config.clientSecret, redirect_uri: `${this.origin.origin}/auth/callback`, code_verifier: flow.verifier }),
      })
      if (!response.ok) throw new Error('token exchange refused')
      const tokens = await response.json()
      ;({ payload } = await jwtVerify(tokens.id_token, this.#keys, {
        issuer: this.config.issuer, audience: this.config.clientId, algorithms: ['RS256'],
        requiredClaims: ['sub', 'tid', 'oid', 'iat', 'exp', 'nonce'], maxTokenAge: '10m',
      }))
      if (!equal(payload.nonce, flow.nonce) || (payload.azp !== undefined && payload.azp !== this.config.clientId)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.config.clientId)) throw new Error('token binding failed')
    } catch (cause) {
      throw new ClaimsAuthError(401, 'AUTH_CALLBACK_INVALID', 'Sign-in could not be verified. Start sign-in again.', { cause })
    }
    const user = payload.tid === this.config.tenant && typeof payload.oid === 'string'
      && await this.#resolveEmployee(payload.tid, payload.oid)
    if (!user) fail(403, 'AUTH_USER_DENIED', 'This account does not have access to the claims demo.')
    this.#prune()
    // A logout can arrive while the token exchange is in flight, before its local session exists.
    if (this.#revokedSessions.has(payload.sid) || payload.iat <= (this.#revokedSubjects.get(payload.sub)?.issuedBefore ?? 0)) {
      fail(401, 'AUTH_CALLBACK_INVALID', 'This sign-in was revoked. Start sign-in again.')
    }
    if (this.#closed || this.#sessions.size >= this.config.maxSessions) fail(503, 'AUTH_CAPACITY', 'Sign-in is unavailable. Try again later.')
    const old = cookie(request, this.cookieName)
    if (old) await this.#remove(old)
    const principal = Object.freeze({ kind: 'claims-user', ...user })
    const peer = this.#createPeer(principal)
    const id = random(), csrfToken = random()
    const expiresAt = Math.min(payload.exp * 1000, this.#now() + this.config.sessionSeconds * 1000)
    const timer = setTimeout(() => { void this.#remove(id) }, Math.max(1, expiresAt - this.#now()))
    timer.unref?.()
    this.#sessions.set(id, { peer, csrfToken, expiresAt, timer, providerSubject: payload.sub, sid: typeof payload.sid === 'string' ? payload.sid : undefined })
    // Commit an app-origin document before navigating: an HTTP redirect would retain
    // the IdP's cross-site Fetch Metadata and fail Connection's request-trust check.
    const scriptNonce = random()
    const landing = flow.resume
    const href = landing.replaceAll('&', '&amp;')
    const response = new Response(`<!doctype html><meta charset="utf-8"><title>Signing in · Enterprise Agent</title><p>Signing you in… <a href="${href}">Continue</a></p><script nonce="${scriptNonce}">location.replace('${landing}')</script>`, {
      status: 200, headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      },
    })
    if (this.config.sharedChat) response.headers.set('clear-site-data', '"storage", "cache"')
    response.headers.append('set-cookie', this.#cookie(this.cookieName, id, Math.max(1, Math.ceil((expiresAt - this.#now()) / 1000))))
    response.headers.append('set-cookie', this.#cookie(this.flowCookieName, '', 0))
    return response
  }

  async #backchannel(request) {
    if (!header(request, 'content-type')?.startsWith('application/x-www-form-urlencoded')) fail(400, 'AUTH_LOGOUT_INVALID', 'Invalid logout request.')
    const body = await request.text()
    if (body.length > 16384) fail(413, 'AUTH_LOGOUT_INVALID', 'Logout request is too large.')
    const params = new URLSearchParams(body)
    if (params.getAll('logout_token').length !== 1) fail(400, 'AUTH_LOGOUT_INVALID', 'Invalid logout request.')
    let payload
    try {
      ;({ payload } = await jwtVerify(params.get('logout_token'), this.#keys, {
        issuer: this.config.issuer, audience: this.config.clientId, algorithms: ['RS256'],
        requiredClaims: ['iat', 'jti', 'events'], maxTokenAge: '2m',
      }))
      if (payload.nonce !== undefined || (typeof payload.sid !== 'string' && typeof payload.sub !== 'string')
        || typeof payload.jti !== 'string' || !payload.events?.['http://schemas.openid.net/event/backchannel-logout']) throw new Error('invalid logout claims')
    } catch (cause) {
      throw new ClaimsAuthError(400, 'AUTH_LOGOUT_INVALID', 'Invalid logout request.', { cause })
    }
    this.#prune()
    if (!this.#logoutIds.has(payload.jti)) {
      if (this.#logoutIds.size >= this.config.maxSessions * 4) fail(503, 'AUTH_CAPACITY', 'Logout delivery is busy. Retry this request.')
      this.#logoutIds.set(payload.jti, this.#now() + 120000)
      const expiresAt = this.#now() + Math.max(600, this.config.sessionSeconds) * 1000
      if (typeof payload.sid === 'string') this.#revokedSessions.set(payload.sid, expiresAt)
      else this.#revokedSubjects.set(payload.sub, { expiresAt, issuedBefore: Math.max(payload.iat, this.#revokedSubjects.get(payload.sub)?.issuedBefore ?? 0) })
      await Promise.all([...this.#sessions].filter(([, session]) => payload.sid ? session.sid === payload.sid
        : session.providerSubject === payload.sub).map(([id]) => this.#remove(id)))
    }
    return this.#response(200, { ok: true })
  }

  /** Own only the explicit authentication routes. */
  async handle(request) {
    const path = new URL(request.url).pathname
    try {
      if (path === '/auth/hosted-chat' && request.method === 'GET') {
        const params = new URL(request.url).searchParams
        const entry = chatTarget(params)
        if (!entry) fail(400, 'invalid_conversation', 'Invalid Claims Agent destination.')
        const admission = this.admit(request)
        if (admission.rejection === 401 && (header(request, 'sec-fetch-mode') === 'navigate' || header(request, 'accept')?.includes('text/html'))) {
          const target = path + new URL(request.url).search
          return this.#response(303, null, { location: loginHref(target) })
        }
        const user = this.require(request)
        if (user.department && !this.config.sharedChat) return this.#response(303, null, { location: '/?mode=workbench&assistant=open#workbench' })
        if (!this.config.sharedChat && entry.startsWith('/chat?record=')) return this.#response(404)
        if (this.config.sharedChat) return this.#response(303, null, { location: '/chat' + new URL(request.url).search +
          (entry.startsWith('/open-claims-chat') ? '#claim-chat' : '') })
        const port = MANAGED_CHAT_PORTS[user.principalId]
        if (!port) fail(403, 'AUTH_USER_DENIED', 'Chat is unavailable for this account.')
        return this.#response(303, null, { location: this.origin.protocol + '//' + this.origin.hostname + ':' + port + entry })
      }
      if (path === '/auth/login' && request.method === 'GET') return this.#login(request)
      if (path === '/auth/signed-out' && request.method === 'GET') {
        this.#trust(request)
        return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg"><title>Signed out · Enterprise Agent</title><main><p><img alt="" width="24" height="24" src="/favicon.svg"> Enterprise Agent</p><h1>You are signed out</h1><p>Your application session has ended.</p><a href="/auth/login">Sign in</a></main></html>', {
          status: 200, headers: {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'none'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          },
        })
      }
      if (path === '/auth/callback' && request.method === 'GET') return await this.#callback(request)
      if (path === '/auth/backchannel-logout' && request.method === 'POST') return await this.#backchannel(request)
      if (path === '/auth/me' && request.method === 'GET') {
        const user = this.require(request)
        return this.#response(200, { user, csrfToken: this.#live(request).csrfToken })
      }
      if (path === '/auth/logout' && request.method === 'POST') {
        this.require(request, { write: true })
        await this.#remove(cookie(request, this.cookieName))
        return this.#response(200, { ok: true }, { 'set-cookie': this.#cookie(this.cookieName, '', 0), ...(this.config.sharedChat && { 'clear-site-data': '"storage", "cache"' }) })
      }
      return this.#response(405, { code: 'AUTH_METHOD_DENIED', message: 'Method not allowed.' })
    } catch (error) {
      if (error instanceof ClaimsAuthError) {
        if (path === '/auth/callback' && error.code === 'AUTH_CALLBACK_INVALID') return this.#callbackRetry(error.status)
        return this.#response(error.status, { code: error.code, message: error.message })
      }
      return this.#response(503, { code: 'AUTH_PROVIDER_UNAVAILABLE', message: 'Sign-in is unavailable. Try again later.' })
    }
  }

  /** Unload revokes every admitted Peer and pending login; sessions never survive a host restart. */
  async dispose() {
    this.#closed = true
    this.#flows.clear()
    await Promise.all([...this.#sessions.keys()].map(id => this.#remove(id)))
    this.#logoutIds.clear()
    this.#revokedSessions.clear()
    this.#revokedSubjects.clear()
  }
}
