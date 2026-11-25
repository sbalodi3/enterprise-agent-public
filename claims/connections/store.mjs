import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DomainError } from '../domain/index.mjs'
import { appId, digest, randomValue } from './oauth.mjs'

const fail = (status, code) => { throw new DomainError(status, code) }
const owner = p => {
  if (!p?.tenantId || !p.subject || !p.principalId) fail(403, 'connection_identity_required')
  return [p.tenantId, p.subject]
}
const provider = 'microsoft'
const idOf = (p, app) => JSON.stringify([...owner(p), app])
const first = res => res.rows[0]

function crypt(key, purpose, value, encrypted = false) {
  const aad = Buffer.from(JSON.stringify(purpose))
  if (encrypted) {
    const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64url'))
    const cipher = createDecipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad)
    cipher.setAuthTag(tag)
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'))
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.')
}

async function transaction(pool, work) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    const value = await work(db)
    await db.query('COMMIT')
    return value
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally { db.release() }
}

export function createConnectionStore({ pool, config, microsoft }) {
  const inflight = new Map()
  const assignment = p => config?.accounts[owner(p).join('/')]?.toLowerCase()
  const tokenPurpose = p => ['tokens', provider, config.issuer, config.clientId, ...owner(p)]
  const flowPurpose = (p, hash) => ['consent', appId, config.issuer, config.clientId, ...owner(p), hash]
  function checkApp(app) { if (app !== appId) fail(404, 'connection_app_unknown') }
  function stop(p) {
    const key = idOf(p, appId)
    for (const c of inflight.get(key) || []) c.abort()
  }
  async function lock(db, p) {
    // Serializes provider token rotation, grant changes and linking, including across hosts.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 3942))', [JSON.stringify([provider, ...owner(p)])])
  }
  async function snapshot(db, p) {
    return first(await db.query(`SELECT g.status,g.version,a.account_id,a.address,
      a.encrypted_tokens IS NOT NULL AS has_credentials
      FROM cw_connection_grants g LEFT JOIN cw_connection_accounts a USING (tenant,subject,provider)
      WHERE g.tenant=$1 AND g.subject=$2 AND g.app=$3`, [...owner(p), appId]))
  }
  function project(p, row) {
    const oid = assignment(p)
    const available = Boolean(oid)
    const agreed = available && row?.account_id === config.tenant + '/' + oid
    const status = row?.status === 'connected' && (!agreed || !row.has_credentials) ? 'reconnect' : row?.status || 'off'
    return { id: appId, available, status, version: row?.version || 0, mode: config?.mode || 'live',
      ...(agreed && { accountId: row.account_id, address: row.address }) }
  }
  async function status(p, app = appId) {
    checkApp(app)
    return project(p, await snapshot(pool, p))
  }
  function checkLive(state, version) {
    if (!state.available || state.status !== 'connected' || (version !== undefined && version !== state.version))
      fail(409, 'microsoft_connection_changed')
  }
  async function expire(db, p) {
    await db.query(`UPDATE cw_connection_grants SET status='reconnect',version=version+1
      WHERE tenant=$1 AND subject=$2 AND provider=$3 AND status='connected'`, [...owner(p), provider])
    await db.query('UPDATE cw_connection_accounts SET encrypted_tokens=NULL WHERE tenant=$1 AND subject=$2 AND provider=$3', [...owner(p), provider])
  }
  return {
    status,
    async commitIfCurrent(p, app, version, fn) {
      checkApp(app)
      if (!Number.isInteger(version)) fail(409, 'microsoft_connection_changed')
      return transaction(pool, async db => {
        await lock(db, p)
        checkLive(project(p, await snapshot(db, p)), version)
        return fn(db)
      })
    },
    async begin(p, session) {
      if (!assignment(p)) fail(503, 'microsoft_connection_unavailable')
      const values = { nonce: randomValue(), verifier: randomValue(), state: randomValue() }
      const url = await microsoft.authorizationUrl(values)
      const hash = digest(values.state)
      const flow = crypt(config.key, flowPurpose(p, hash), { nonce: values.nonce, verifier: values.verifier })
      await transaction(pool, async db => {
        await lock(db, p)
        if (project(p, await snapshot(db, p)).status === 'connected') fail(409, 'microsoft_already_connected')
        const grant = first(await db.query(`INSERT INTO cw_connection_grants(tenant,subject,app,provider,status,version)
          VALUES ($1,$2,$3,$4,'off',1) ON CONFLICT(tenant,subject,app) DO UPDATE
          SET version=cw_connection_grants.version+1 RETURNING version`, [...owner(p), appId, provider]))
        await db.query(`DELETE FROM cw_connection_attempts WHERE expires_at<=now() OR (tenant=$1 AND subject=$2 AND app=$3)`, [...owner(p), appId])
        await db.query(`INSERT INTO cw_connection_attempts(state_hash,tenant,subject,app,version,session_hash,encrypted_flow,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')`, [hash, ...owner(p), appId, grant.version, digest(session), flow])
      })
      return { url }
    },
    async complete(p, session, params, recheck) {
      const oid = assignment(p)
      const state = params.get('state')
      if (!oid || params.getAll('state').length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(state || '')) fail(400, 'microsoft_callback_invalid')
      const hash = digest(state)
      const attempt = first(await pool.query(`DELETE FROM cw_connection_attempts
        WHERE state_hash=$1 AND tenant=$2 AND subject=$3 AND app=$4 AND session_hash=$5 AND expires_at>now()
        RETURNING version,encrypted_flow`, [hash, ...owner(p), appId, digest(session)]))
      if (!attempt) fail(400, 'microsoft_callback_expired')
      if (params.has('error')) fail(400, 'microsoft_consent_declined')
      const code = params.get('code')
      if (params.getAll('code').length !== 1 || !code || code.length > 8192) fail(400, 'microsoft_callback_invalid')
      const flow = crypt(config.key, flowPurpose(p, hash), attempt.encrypted_flow, true)
      const linked = await microsoft.exchange(code, flow, oid)
      await transaction(pool, async db => {
        await lock(db, p)
        recheck()
        const valid = await db.query(`UPDATE cw_connection_grants SET status='connected', version=version+1
          WHERE tenant=$1 AND subject=$2 AND app=$3 AND version=$4`, [...owner(p), appId, attempt.version])
        if (!valid.rowCount) fail(409, 'microsoft_connection_changed')
        await db.query(`INSERT INTO cw_connection_accounts(tenant,subject,provider,account_id,address,encrypted_tokens)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant,subject,provider)
          DO UPDATE SET account_id=excluded.account_id,address=excluded.address,encrypted_tokens=excluded.encrypted_tokens`,
          [...owner(p), provider, linked.accountId, linked.address, crypt(config.key, tokenPurpose(p), linked.tokens)])
        recheck()
      })
    },
    async disconnect(p) {
      await transaction(pool, async db => {
        await lock(db, p)
        await db.query(`UPDATE cw_connection_grants SET status='off',version=version+1
          WHERE tenant=$1 AND subject=$2 AND app=$3`, [...owner(p), appId])
        await db.query('DELETE FROM cw_connection_attempts WHERE tenant=$1 AND subject=$2 AND app=$3', [...owner(p), appId])
        await db.query(`UPDATE cw_connection_accounts SET encrypted_tokens=NULL WHERE tenant=$1 AND subject=$2 AND provider=$3
          AND NOT EXISTS(SELECT 1 FROM cw_connection_grants WHERE tenant=$1 AND subject=$2 AND provider=$3 AND status='connected')`,
          [...owner(p), provider])
      })
      stop(p)
      return { ok: true }
    },
    async withAccess(p, app, fn, { expectedVersion, signal } = {}) {
      checkApp(app)
      const key = idOf(p, app)
      const controller = new AbortController()
      if (!inflight.has(key)) inflight.set(key, new Set())
      const set = inflight.get(key)
      set.add(controller)
      const leaseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      try {
        const lease = await transaction(pool, async db => {
          await lock(db, p)
          leaseSignal.throwIfAborted()
          const state = project(p, await snapshot(db, p))
          checkLive(state, expectedVersion)
          const account = first(await db.query('SELECT encrypted_tokens FROM cw_connection_accounts WHERE tenant=$1 AND subject=$2 AND provider=$3', [...owner(p), provider]))
          let cache
          try { cache = crypt(config.key, tokenPurpose(p), account.encrypted_tokens, true) }
          catch {
            // Credentials sealed with a retired encryption key or a different OAuth
            // configuration cannot be reused. Preserve the verified account identity.
            await expire(db, p)
            return null
          }
          if (cache.expires <= Date.now() + 60000) {
            try { cache = await microsoft.refresh(cache) }
            catch (error) {
              if (!['microsoft_reconnect_required','microsoft_mail_scope_required'].includes(error.code)) throw error
              // Commit the loss of authority before returning the reconnect error.
              await expire(db, p)
              return null
            }
            await db.query('UPDATE cw_connection_accounts SET encrypted_tokens=$4 WHERE tenant=$1 AND subject=$2 AND provider=$3',
              [...owner(p), provider, crypt(config.key, tokenPurpose(p), cache)])
          }
          return { token: cache.access, version: state.version, accountId: state.accountId, graphOrigin: config.graphOrigin, signal: leaseSignal,
            async check() {
              leaseSignal.throwIfAborted()
              checkLive(await status(p, app), state.version)
              leaseSignal.throwIfAborted()
            } }
        })
        if (!lease) { stop(p); fail(401, 'microsoft_reconnect_required') }
        leaseSignal.throwIfAborted()
        let result
        try { result = await fn(lease) }
        catch (error) {
          if (error.code === 'microsoft_reconnect_required' && !leaseSignal.aborted) {
            const expired = await transaction(pool, async db => {
              await lock(db, p)
              const row = await snapshot(db, p)
              if (row?.version !== lease.version || row.status !== 'connected') return false
              const account = first(await db.query('SELECT encrypted_tokens FROM cw_connection_accounts WHERE tenant=$1 AND subject=$2 AND provider=$3', [...owner(p), provider]))
              if (!account || crypt(config.key, tokenPurpose(p), account.encrypted_tokens, true).access !== lease.token) return false
              await expire(db, p)
              return true
            })
            if (expired) stop(p)
          }
          throw error
        }
        await lease.check()
        return result
      } finally {
        set.delete(controller)
        if (!set.size) inflight.delete(key)
      }
    },
  }
}
