import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import {
  card,
  cardPath,
  contextId,
  exact,
  handoffId,
  peerUrl,
  taskId,
  validReply,
  validRequest,
} from './a2a-contract.mjs'

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const invalid = () => new RpcError(-32602, 'Invalid params')
const unknownTask = () => new RpcError(-32001, 'Task not found')
const authHash = (value) => createHash('sha256').update(value).digest()

/** Private peer retains completed tasks and deduplicates each handoff on its own volume. */
export function createLegalPeer({ path = ':memory:', origin = peerUrl, token, reviewToken }) {
  if (!token || !reviewToken || token === reviewToken)
    throw Error('Two distinct portfolio service credentials are required')
  const financeHash = authHash('Bearer ' + token)
  const legalHash = authHash('Bearer ' + reviewToken)
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS legal_tasks(
      id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT, updated TEXT NOT NULL
    );`)
  const get = db.prepare('SELECT * FROM legal_tasks WHERE id=?')
  const insert = db.prepare('INSERT INTO legal_tasks(id,input,updated) VALUES(?,?,?) ON CONFLICT DO NOTHING')
  const approve = db.prepare('UPDATE legal_tasks SET result=?, updated=? WHERE id=? AND result IS NULL')
  function lookup(id) {
    if (typeof id !== 'string' || !id.startsWith('authorization-')) throw unknownTask()
    const row = get.get(id.slice('authorization-'.length))
    if (!row) throw unknownTask()
    return row
  }
  function task(row) {
    const result = row.result && JSON.parse(row.result)
    return {
      kind: 'task',
      id: taskId(row.id),
      contextId: contextId(row.id),
      status: { state: result ? 'completed' : 'working', timestamp: row.updated },
      ...(result && {
        artifacts: [
          {
            artifactId: 'review-' + row.id,
            name: 'Reviewed expense authorization',
            parts: [{ kind: 'data', data: result }],
          },
        ],
      }),
    }
  }
  function dispatch(method, params, reviewer) {
    if (method === 'tasks/get') {
      if (!exact(params, ['id'])) throw invalid()
      return task(lookup(params.id))
    }
    if (method === 'tasks/cancel') {
      lookup(params?.id)
      throw new RpcError(-32002, 'This reviewed task cannot be canceled')
    }
    if (method !== 'message/send') throw new RpcError(-32601, 'Method not found')
    const m = params?.message
    const fields = reviewer
      ? ['kind', 'role', 'messageId', 'taskId', 'contextId', 'parts']
      : ['kind', 'role', 'messageId', 'parts']
    if (
      !exact(params, ['message']) ||
      !exact(m, fields) ||
      m.kind !== 'message' ||
      m.role !== 'user' ||
      !Array.isArray(m.parts) ||
      m.parts.length !== 1 ||
      !exact(m.parts[0], ['kind', 'data']) ||
      m.parts[0].kind !== 'data'
    )
      throw invalid()
    const data = m.parts[0].data
    if (reviewer) {
      const row = lookup(m.taskId)
      if (m.messageId !== 'review-' + row.id || m.contextId !== contextId(row.id) || !validReply(data))
        throw invalid()
      const payload = JSON.stringify({ disposition: data.disposition, reference: data.reference })
      if (row.result && payload !== row.result) throw invalid()
      approve.run(payload, new Date().toISOString(), row.id)
      return task(get.get(row.id))
    }
    if (!handoffId(m.messageId) || !validRequest(data)) throw invalid()
    // Normalize order so retries through another JSON serializer have the same identity.
    const payload = JSON.stringify(data, Object.keys(data).sort())
    insert.run(m.messageId, payload, new Date().toISOString())
    const row = get.get(m.messageId)
    if (row.input !== payload) throw invalid()
    return task(row)
  }
  const server = createServer({ requestTimeout: 8000 }, async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' })
    const auth = authHash(req.headers.authorization || '')
    const reviewer = timingSafeEqual(auth, legalHash)
    if (!reviewer && !timingSafeEqual(auth, financeHash)) return send(401, { error: 'service_auth_required' })
    if (req.method === 'GET' && req.url === cardPath) return send(200, card(origin))
    if (req.method !== 'POST' || req.url !== '/a2a') return send(404, { error: 'not_found' })
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
      return send(415, { error: 'expected_json' })
    let id = null
    try {
      const chunks = []
      let size = 0
      for await (const part of req) {
        size += part.length
        if (size > 8192) return send(413, { error: 'body_too_large' })
        chunks.push(part)
      }
      let rpc
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw new RpcError(-32700, 'Parse error')
      }
      if (
        !exact(rpc, ['jsonrpc', 'id', 'method', 'params']) ||
        rpc.jsonrpc !== '2.0' ||
        !['number', 'string'].includes(typeof rpc.id)
      )
        throw new RpcError(-32600, 'Invalid request')
      id = rpc.id
      const result = dispatch(rpc.method, rpc.params, reviewer)
      send(200, { jsonrpc: '2.0', id, result })
    } catch (err) {
      if (err instanceof RpcError)
        return send(200, { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } })
      send(503, { error: 'peer_unavailable' })
    }
  })
  server.once('close', () => db.close())
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createLegalPeer({
    path: '/data/harness/legal-agent.sqlite',
    token: process.env.PORTFOLIO_A2A_TOKEN,
    reviewToken: process.env.PORTFOLIO_A2A_REVIEW_TOKEN,
  })
  server.listen(3092, '0.0.0.0')
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close())
}
