import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { cmsSnapshotPath } from '../cms-mcp/snapshot.mjs'
import pg from 'pg'
import { initializeJuris, JurisError, jurisStore } from './store.mjs'

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new JurisError(415, 'expected_json')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 12_288) throw new JurisError(413, 'body_too_large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new JurisError(400, 'invalid_json')
  }
}

export function createJurisServer(store, token) {
  if (!token?.trim()) throw new Error('Missing JURIS_SERVICE_TOKEN')
  const hash = (s) => createHash('sha256').update(s).digest()
  const auth = hash(`Bearer ${token}`)
  return createServer({ requestTimeout: 10_000 }, async (req, res) => {
    const send = (status, object) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(object))
    }
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' })
      if (!timingSafeEqual(auth, hash(req.headers.authorization || '')))
        throw new JurisError(401, 'service_auth_required')
      const claim = /^\/v1\/claims\/(WC-\d{3}|CLM-\d{6})$/.exec(req.url)
      if (req.method === 'GET' && claim) return send(200, await store.read(claim[1]))
      // encodeURIComponent encodes the colon in namespaced operation identifiers.
      const receipt = /^\/v1\/receipts\/([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159})$/.exec(
        req.url.replaceAll(/%3a/gi, ':'),
      )
      if (req.method === 'GET' && receipt) return send(200, await store.receipt(receipt[1]))
      if (req.method === 'POST' && req.url === '/v1/commands')
        return send(200, await store.apply(await jsonBody(req)))
      throw new JurisError(404, 'not_found')
    } catch (err) {
      if (err instanceof JurisError) return send(err.status, { error: err.message })
      return send(503, { error: 'juris_unavailable' })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { JURIS_DATABASE_URL, JURIS_SERVICE_TOKEN, JURIS_PORT = '3091', JURIS_HOST = '0.0.0.0' } = process.env
  if (!JURIS_DATABASE_URL || !JURIS_SERVICE_TOKEN)
    throw new Error('Mock JURIS requires its own database URL and service token')
  const pool = new pg.Pool({ connectionString: JURIS_DATABASE_URL, max: 8 })
  pool.on('error', () => console.error('Mock JURIS database connection interrupted'))
  await initializeJuris(pool, process.env.CLAIMS_CMS_MCP === '1' ? JSON.parse(await readFile(cmsSnapshotPath,'utf8')) : null)
  const server = createJurisServer(jurisStore(pool), JURIS_SERVICE_TOKEN)
  server.listen(Number(JURIS_PORT), JURIS_HOST)
  const close = () => server.close(() => pool.end())
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
}
