import { pdfViewerHref } from '../ui/pdf-link.mjs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { DomainError } from '../domain/index.mjs'

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}
function reply(res, status, body) {
  res.writeHead(status, jsonHeaders)
  res.end(JSON.stringify(body))
}
function fail(status, code) {
  throw new DomainError(status, code)
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'json_required')
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 16384) fail(413, 'request_too_large')
    chunks.push(chunk)
  }
  let data
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail(400, 'invalid_json')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'invalid_json_object')
  return data
}
const hash = (token) => createHash('sha256').update(token).digest()
const id = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_:.-]{1,128}$/.test(value)) fail(400, 'invalid_identifier')
  return value
}
export function createApi({ domain, auth, connections, mailChat, requireMailSession, shutdown, assist, conversationApi, departmentApi, profile, workerToken, workflow, trace, ready, showcase }) {
  const internalToken = workerToken ? hash('Bearer ' + workerToken) : null
  const writes = {
    'wage/start': 'startWage',
    'wage/accept': 'acceptWage',
    'wage/status': 'wageStatus',
    'wage/timeout': 'timeoutWage',
    'wage/delivered': 'ackWageDelivery',
    dispatch: 'dispatchOperation',
    reconcile: 'reconcileOperation',
  }
  async function internal(req, path) {
    if (!internalToken || !timingSafeEqual(internalToken, hash(req.headers.authorization || '')))
      fail(403, 'forbidden')
    if (req.method === 'GET' && path === 'dispatchable') return domain.dispatchable()
    if (req.method === 'GET' && path === 'wage/pending') return domain.wageDeliveries()
    if (showcase && req.method === 'POST' && ['wage/start', 'wage/accept', 'wage/poll'].includes(path)) {
      const input = await body(req)
      return trace.run('worker.' + path, () => showcase.activity(path, input), await domain.wageSpan(input))
    }
    if (req.method === 'POST' && Object.hasOwn(writes, path)) {
      const input = await body(req)
      const link = input.operationId
        ? await domain.operationSpan(input)
        : input.requestId
          ? await domain.wageSpan(input)
          : null
      return trace.run('worker.' + writes[path], () => domain[writes[path]](input), link)
    }
    fail(404, 'not_found')
  }
  async function publicApi(req, path, query, res) {
    const write = req.method === 'POST'
    let user
    try { user = auth.require(req, { write }) } catch (error) {
      const file = /^media\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(path)
      if (error.status === 401 && showcase && req.method === 'GET' && file && query.get('format') === 'pdf' &&
          (req.headers['sec-fetch-mode'] === 'navigate' || req.headers.accept?.includes('text/html'))) {
        res.writeHead(303, { location: pdfViewerHref({ claimId: file[1], documentId: file[2] }), 'cache-control': 'no-store' }).end()
        return
      }
      throw error
    }
    if (!write && req.method !== 'GET') fail(405, 'method_not_allowed')
    const mailbox = /^mail-chat\/([A-Za-z0-9_-]{1,128})$/.exec(path)
    if (mailbox && mailChat) {
      const peer = auth.admit(req).peer
      if (!peer) fail(401, 'AUTH_REQUIRED')
      const stopped = new AbortController()
      const onClose = () => stopped.abort()
      res.once('close', onClose)
      try {
        const signal = AbortSignal.any([peer.signal, stopped.signal, shutdown, AbortSignal.timeout(150000)].filter(Boolean))
        const reauthorize = async () => {
          signal.throwIfAborted()
          const principal = auth.require(req)
          if (requireMailSession && (principal.department || mailbox[1].startsWith('session-')))
            await requireMailSession(principal, mailbox[1])
        }
        const answer = await mailChat({ principal: user, method: req.method, path: mailbox[1],
          input: write ? await body(req) : { before: query.get('before') || undefined, turn: query.get('turn') || undefined }, signal, reauthorize })
        await reauthorize()
        return answer
      } finally {
        res.off('close', onClose)
      }
    }
    if (path.startsWith('departments/') && departmentApi) {
      const input = write ? await body(req) : {}
      const recheck = () => auth.require(req, { write })
      const result = await trace.run('departments.request', () => departmentApi({
        path: path.slice('departments/'.length), user, input, write, recheck, res, query,
      }))
      if (!res.headersSent) recheck()
      return result
    }
    if (user.department && departmentApi && !write && path === 'chat/bootstrap') {
      return { enabled: true, department: user.department, subject: user.subject, csrfToken: auth.browserCsrf(req) }
    }
    if (user.department) fail(404, 'not_found')
    const parts = path.split('/')
    const [resource, key, verb] = parts
    if (parts.length > 3 || (key && !id(key))) fail(404, 'not_found')
    const input = write ? await body(req) : {}
    // Only route names and server-generated trace IDs enter telemetry.
    const category = [
      'portfolio',
      'mailbox',
      'items',
      'evidence',
      'assist',
      'chat',
      'proposals',
      'decisions',
      'fixtures',
      'wages',
      'operations',
      'evaluate',
      'dataset',
      'status',
    ].includes(resource)
      ? resource
      : 'unmatched'
    return trace.run(category, async (traceId, spanId, link) => {
      res.setHeader('x-claims-trace-id', traceId)
      const ctx = { ...user, profileId: profile.id, traceId, spanId }
      if (resource === 'chat' && conversationApi) {
        const data = await conversationApi(req, res, ctx, path.slice('chat/'.length), input, query)
        if (!res.headersSent) auth.require(req)
        return data
      }
      if (!write) {
        if (resource === 'items' && verb === 'actions' && showcase) return domain.availableActions(ctx,key)
        if (path === 'portfolio') return domain.portfolio(ctx, { ranking: query.get('ranking') ?? 'rules',
          status: query.get('status') ?? 'open', query: query.get('q') ?? '', lob: query.get('lob') ?? '', ownerId: query.get('ownerId') ?? '' })
        if (path === 'adjusters') return domain.adjusters(ctx)
        if (path === 'portfolio-summary' && showcase && await domain.cmsEnabled(ctx)) return domain.portfolioSummary(ctx, {
          groupBy: query.get('groupBy') ?? 'lob', status: query.get('status') ?? 'all', sourceStatus: query.get('sourceStatus') ?? '', lob: query.get('lob') ?? '', ownerId: query.get('ownerId') ?? '' })
        if (path === 'mailbox') return domain.mailbox(ctx)
        if (path === 'status')
          return { profile: profile.id, release: profile.release, wageReview: process.env.CLAIMS_WAGE_REVIEW === '1', workflow: !!workflow, showcase: !!showcase, cmsDataset: !!showcase && await domain.cmsEnabled(ctx) }
        if (showcase && resource === 'items' && key && verb === 'juris') return domain.sourceRecord(ctx, key)
        if (showcase && resource === 'documents' && key && verb) return domain.document(ctx, key, id(verb))
        if (showcase && resource === 'media' && key && verb)
          return showcase.media(ctx, key, id(verb), query.get('format'), req, res, () => auth.require(req))
        if (path === 'dataset') return domain.dataset(ctx)
        if (path === 'evaluate') return domain.evaluate(ctx)
        if (resource === 'items' && key && verb === 'sessions') return domain.sessions(ctx, key)
        if (key && parts.length === 2) {
          if (resource === 'items') return domain.detail(ctx, key)
          if (resource === 'evidence')
            return domain.evidence(ctx, key, { decisionSetId: query.get('decisionSetId') })
          if (resource === 'sessions') return domain.session(ctx, key)
          if (resource === 'operations') return domain.operation(ctx, key)
        }
      } else {
        if (showcase && resource === 'items' && verb === 'mcp') {
          if (
            input.jsonrpc === '2.0' &&
            input.method === 'notifications/initialized' &&
            input.id === undefined
          ) {
            await domain.detail(ctx, key)
            res.writeHead(202, { 'cache-control': 'no-store' }).end()
            return
          }
          return showcase.mcp(ctx, key, input)
        }
        if (showcase && resource === 'items' && verb === 'release')
          return showcase.release(ctx, key, id(input.requestId))
        if (showcase && path === 'showcase/call') return showcase.deliver(ctx)
        if (path === 'assist') return assist(ctx, input, () => auth.require(req, { write: true }))
        if (path === 'evaluate') return domain.evaluate(ctx, input)
        if (path === 'fixtures') {
          if (showcase) fail(404, 'not_found')
          if (input.requestId) {
            id(input.requestId)
            id(input.eventId)
            if (!workflow) fail(409, 'story_profile_required')
          }
          const delivery = await domain.fixture(ctx, input)
          if (input.requestId) link(await domain.wageSpan(input))
          return delivery
        }
        if (path === 'wages') {
          if (!workflow) fail(409, 'story_profile_required')
          const requestId = id(input.requestId)
          return domain.admitWage(ctx, {
            requestId,
            workItemId: id(input.itemId),
            expectedVersion: input.expectedVersion,
          })
        }
        if (key && verb) {
          if (resource === 'mailbox' && verb === 'answer') return domain.answer(ctx, key, input)
          if (resource === 'mailbox' && verb === 'read') return domain.acknowledge(ctx, key)
          if (resource === 'items') {
            if (verb === 'claim') return domain.claimIntake(ctx, key, input)
            if (verb === 'request') return domain.peerRequest(ctx, key, input)
            if (verb === 'transfer') return domain.transfer(ctx, key, input)
            if (verb === 'prepare') return domain.prepare(ctx, key, input)
          }
          if (resource === 'decisions') {
            if (verb === 'feedback') return domain.feedback(ctx, key, input)
            if (verb === 'exposure') return domain.exposure(ctx, key, input)
          }
          if (resource === 'proposals' && verb === 'review') {
            const result = await domain.review(ctx, key, input)
            if (result.requestId) link(await domain.proposalSpan(key))
            if (result.operationId && !workflow && !result.requestId) {
              result.operation = await trace.run('simulator.dispatch', () =>
                domain.dispatchOperation({ operationId: result.operationId }),
              )
            }
            return result
          }
          if (resource === 'operations' && verb === 'reconcile') {
            const op = await domain.operation(ctx, key)
            const current = await domain.detail(ctx, op.workItemId)
            if (!current.canAct) fail(403, 'read_only')
            if (op.state !== 'unknown') fail(409, 'reconciliation_unavailable')
            if (workflow) {
              const client = await workflow()
              try {
                if (op.requestId) await client.reconcileWage(op.requestId)
                else await client.requestReconciliation(key)
              } catch (error) {
                // A completed workflow may have exhausted its reconciliation
                // window. An explicit lookup can still recover its existing receipt.
                if (error.name !== 'WorkflowNotFoundError') throw error
                return domain.reconcileOperation({ operationId: key })
              }
              return { operationId: key, state: 'reconciliation-requested' }
            }
            return domain.reconcileOperation({ operationId: key })
          }
        }
      }
      fail(404, 'not_found')
    })
  }
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname
      let data
      if (connections && (path === '/claims/api/connections' || path.startsWith('/claims/api/connections/') ||
        path === '/claims/connections/microsoft/callback')) {
        await connections.handle(req, res)
        return
      }
      if (path === '/health/ready' && req.method === 'GET') {
        await ready()
        data = { ready: true }
      } else if (showcase && path.startsWith('/claims/integrations/showcase/'))
        data = await showcase.receive(req, body)
      else if (path.startsWith('/api/internal/work/'))
        data = await internal(req, path.slice('/api/internal/work/'.length))
      else if (path.startsWith('/claims/api/'))
        data = await publicApi(req, path.slice('/claims/api/'.length), url.searchParams, res)
      else fail(404, 'not_found')
      if (!res.writableEnded && !res.destroyed) reply(res, 200, data)
    } catch (error) {
      const known =
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status < 600 &&
        typeof error.code === 'string'
      if (!known) console.error('Claims request failed', error.name)
      reply(res, known ? error.status : 503, { code: known ? error.code : 'service_unavailable' })
    }
  }
}
