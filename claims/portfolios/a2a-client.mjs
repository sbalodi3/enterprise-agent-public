import { randomUUID } from 'node:crypto'
import {
  cardPath,
  contextId,
  handoffId,
  peerUrl,
  requestData,
  SKILL,
  taskId,
  validReply,
  validRequest,
} from './a2a-contract.mjs'

/** Deliver one persisted outbox entry and advance the mailbox only after a verified peer response. */
export function createHandoffClient({ url = peerUrl, token, reviewToken, fetchFn = fetch }) {
  const origin = new URL(url)
  if (
    (origin.origin !== peerUrl && !['127.0.0.1', '[::1]'].includes(origin.hostname)) ||
    url !== origin.origin ||
    origin.protocol !== 'http:'
  )
    throw Error('Expected the private Legal peer origin')
  if (!token || !reviewToken || token === reviewToken)
    throw Error('Two distinct portfolio service credentials are required')
  async function json(path, bearer, body) {
    const res = await fetchFn(origin.origin + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer ' + bearer, ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    })
    if (!res.ok || !res.headers.get('content-type')?.startsWith('application/json'))
      throw Error('Legal peer unavailable')
    const reader = res.body.getReader()
    const parts = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if ((size += value.length) > 12_288) {
          await reader.cancel()
          throw Error('Legal peer response too large')
        }
        parts.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  }
  async function rpc(method, params, bearer) {
    const id = randomUUID()
    const reply = await json('/a2a', bearer, { jsonrpc: '2.0', id, method, params })
    if (reply.jsonrpc !== '2.0' || reply.id !== id || reply.error || !reply.result)
      throw Error('Legal peer rejected the operation')
    return reply.result
  }
  function verifyTask(result, id) {
    if (
      result.kind !== 'task' ||
      result.id !== taskId(id) ||
      result.contextId !== contextId(id) ||
      !['completed', 'working'].includes(result.status?.state)
    )
      throw Error('Unverified Legal task')
  }
  function message(messageId, data, extra = {}) {
    return {
      message: { kind: 'message', role: 'user', messageId, ...extra, parts: [{ kind: 'data', data }] },
    }
  }
  return async (store, row) => {
    if (!handoffId(row.id) || !validRequest(requestData(row))) throw Error('Invalid expense handoff')
    const card = await json(cardPath, token)
    if (
      card.protocolVersion !== '0.3.0' ||
      card.version !== '1.0.0' ||
      card.url !== origin.origin + '/a2a' ||
      card.preferredTransport !== 'JSONRPC' ||
      card.securitySchemes?.financeService?.scheme !== 'bearer' ||
      !card.skills?.some((skill) => skill.id === SKILL)
    )
      throw Error('Unexpected Legal agent card')
    if (row.state === 'queued') {
      const task = await rpc('message/send', message(row.id, requestData(row)), token)
      verifyTask(task, row.id)
      await store.noteHandoffSent(row.id)
      return
    }
    const approved = { disposition: row.disposition, reference: row.reference }
    if (row.state !== 'reply_queued' || !validReply(approved)) throw Error('Invalid review')
    const linked = { contextId: contextId(row.id), taskId: taskId(row.id) }
    const accepted = await rpc('message/send', message('review-' + row.id, approved, linked), reviewToken)
    verifyTask(accepted, row.id)
    const task = await rpc('tasks/get', { id: taskId(row.id) }, token)
    verifyTask(task, row.id)
    const artifact = task.artifacts?.[0]
    const receipt = artifact?.parts?.[0]
    if (
      task.status.state !== 'completed' ||
      task.artifacts?.length !== 1 ||
      artifact?.artifactId !== 'review-' + row.id ||
      artifact.parts?.length !== 1 ||
      receipt?.kind !== 'data' ||
      !validReply(receipt.data) ||
      approved.disposition !== receipt.data.disposition ||
      approved.reference !== receipt.data.reference
    )
      throw Error('Unverified Legal receipt')
    await store.finishHandoff(row.id, receipt.data)
  }
}

/** Single-flight pump. Its durable retry obligation lives in the department store. */
export function startPortfolioHandoffs({
  store,
  url = process.env.PORTFOLIO_LEGAL_A2A_URL,
  token = process.env.PORTFOLIO_A2A_TOKEN,
  reviewToken = process.env.PORTFOLIO_A2A_REVIEW_TOKEN,
  intervalMs = 2500,
}) {
  const deliver = createHandoffClient({ url, token, reviewToken })
  let active,
    stopped = false,
    again = false,
    reported = false
  function report() {
    if (!reported) console.warn('Department A2A delivery pending retry')
    reported = true
  }
  async function drain() {
    do {
      again = false
      let failure = false
      for (const entry of await store.pendingHandoffs()) {
        if (stopped) break
        try {
          await deliver(store, entry)
        } catch {
          failure = true
          report()
        }
      }
      if (!failure) reported = false
    } while (again && !stopped)
  }
  function wake() {
    if (stopped) return
    if (active) {
      again = true
      return
    }
    active = drain()
      .catch(report)
      .finally(() => {
        active = null
      })
  }
  const timer = setInterval(wake, intervalMs)
  timer.unref()
  wake()
  return {
    wake,
    async stop() {
      stopped = true
      clearInterval(timer)
      await active
    },
  }
}
