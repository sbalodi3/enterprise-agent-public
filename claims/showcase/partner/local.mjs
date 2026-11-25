import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { wageDisclosure } from '../data/wage-cases.mjs'

const schema = 'query.wage_evidence/1.0.0/output'
const hex = value => createHash('sha256').update(value).digest('hex')
const opaque = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
const equalFields = (input, expected) => input && expected &&
  Object.keys(input).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => input[key] === value)

function reference(task) {
  return { requestId: task.request_id, workItemId: task.item, taskId: task.task_id,
    contextId: task.context_id, eventId: 'wage-result:' + task.task_id }
}

function receipt(task) {
  return { ...reference(task), state: 'working', receiptId: task.task_id,
    operationId: task.operation_id, payloadDigest: task.payload_digest, type: 'request_wages',
    claimId: task.item, appliedAt: task.applied_at }
}

function evidence(task, signingKey) {
  const { dateRangeStart, dateRangeEnd } = wageDisclosure(task.item, task.actor)
  const payPeriods = []
  const end = Date.parse(dateRangeEnd)
  const day = 86_400_000
  const date = time => new Date(time).toISOString().slice(0, 10)
  for (let start = Date.parse(dateRangeStart); start <= end; start += 14 * day) {
    payPeriods.push({
      periodStart: date(start), periodEnd: date(Math.min(end, start + 13 * day)),
      grossEarnings: { amount: '1830.00', currency: 'USD' },
      hours: { regular: 80, overtime: 4 },
    })
    if (task.item === 'CLM-000020' || task.item === 'WC-102') break
  }
  const data = { payPeriods }
  const artifact = { schema, data, provenance: {
    sourceSystem: 'synthetic-payroll', asOf: '2026-11-17T13:00:00Z',
    recordIds: payPeriods.map((_, index) => `${task.task_id}:${index + 1}`),
    policyDecisionId: 'synthetic-wage-disclosure-v1', sensitivityTier: 'internal', withheld: [],
    payloadHash: 'sha256:' + hex(JSON.stringify(data)),
  } }
  const signed = JSON.stringify({ ...reference(task), artifact })
  const signature = createHmac('sha256', signingKey).update(signed).digest('hex')
  return { ...reference(task), state: 'completed', artifact, signedResponseHash: 'sha256:' + hex(signed + '.' + signature) }
}

async function read(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16384) return null
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks)) } catch { return null }
}

export function localWagePartner({ db, token, signingKey, noticeUrl, fetchNotice = fetch }) {
  if (!token || !signingKey || !noticeUrl) throw Error('Configure the synthetic wage service')
  const bearer = hex('Bearer ' + token)
  db.exec(`CREATE TABLE IF NOT EXISTS synthetic_requests (
    request_id TEXT PRIMARY KEY, item TEXT NOT NULL, actor TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE,
    context_id TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0
  )`)
  const lookup = db.prepare('SELECT * FROM synthetic_requests WHERE request_id=?')
  const register = db.prepare(`INSERT OR IGNORE INTO synthetic_requests
    (request_id,item,actor,operation_id,payload_digest,task_id,context_id,applied_at)
    VALUES (?,?,?,?,?,?,?,?)`)
  const release = db.prepare('UPDATE synthetic_requests SET released=1 WHERE request_id=?')
  return async function handle(req, res) {
    const send = (status, body) => res.writeHead(status, {
      'content-type': 'application/json', 'cache-control': 'no-store',
    }).end(JSON.stringify(body))
    const { method, url } = req
    if (method === 'GET' && url === '/healthz') return send(200, { status: 'ok' })
    if (!timingSafeEqual(Buffer.from(bearer), Buffer.from(hex(req.headers.authorization || ''))))
      return send(401, { error: 'service_authentication_required' })
    if (method === 'POST' && url === '/requests') {
      const input = await read(req)
      if (!input || ![input.requestId, input.operationId, input.actorId].every(value => typeof value === 'string' && opaque.test(value)) ||
          !/^[a-f0-9]{64}$/.test(input.payloadDigest) || !equalFields(input.input, wageDisclosure(input.workItemId, input.actorId)))
        return send(422, { error: 'invalid_synthetic_disclosure' })
      register.run(input.requestId, input.workItemId, input.actorId, input.operationId, input.payloadDigest,
        randomUUID(), randomUUID(), new Date().toISOString())
      const task = lookup.get(input.requestId)
      if (!task || task.item !== input.workItemId || task.actor !== input.actorId ||
          task.operation_id !== input.operationId || task.payload_digest !== input.payloadDigest)
        return send(409, { error: 'registration_conflict' })
      return send(200, receipt(task))
    }
    const route = /^\/requests\/([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159})(?:\/(registration|receipt|release))?$/.exec(url)
    const task = route && lookup.get(route[1])
    if (!task) return send(404, { error: 'unknown_synthetic_request' })
    if (method === 'GET' && ['registration', 'receipt'].includes(route[2])) return send(200, receipt(task))
    if (method === 'GET' && !route[2])
      return send(200, task.released ? evidence(task, signingKey) : { ...reference(task), state: 'working' })
    if (method === 'POST' && route[2] === 'release') {
      release.run(task.request_id)
      const notification = reference(task)
      let notificationDelivered = false
      try {
        const response = await fetchNotice(noticeUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(notification) })
        notificationDelivered = response.ok
      } catch { /* The released result remains available for the worker's next poll. */ }
      return send(200, { released: true, notificationDelivered })
    }
    return send(405, { error: 'method_not_allowed' })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new DatabaseSync(process.env.PARTNER_DB || '/data/harness/synthetic-wages.sqlite3')
  const handle = localWagePartner({ db, token: process.env.SHOWCASE_PARTNER_TOKEN,
    signingKey: process.env.SHOWCASE_CALLBACK_TOKEN, noticeUrl: process.env.WORKBENCH_NOTICE_URL })
  const server = createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(503); res.end() })
  })
  server.listen(8090, '0.0.0.0')
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => db.close()))
}
