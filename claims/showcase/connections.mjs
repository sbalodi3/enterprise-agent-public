import { timingSafeEqual, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DomainError } from '../domain/index.mjs'
import { renderDocumentPdf } from './data/documents.mjs'
import { timelineRpc } from './timeline.mjs'

const hash = (value) => createHash('sha256').update(value).digest()
export function hasBearer(req, token) {
  return Boolean(token) && timingSafeEqual(hash(req.headers.authorization || ''), hash('Bearer ' + token))
}
function partnerClient(env) {
  const token = env.SHOWCASE_PARTNER_TOKEN
  async function partner(path, body) {
    const r = await fetch(new URL(path, env.SHOWCASE_PARTNER_URL), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    if (r.status === 404 && body === undefined && path.endsWith('/registration')) return null
    if (!r.ok)
      throw new DomainError(
        r.status === 409 ? 409 : 503,
        r.status === 409 ? 'partner_task_pending' : 'partner_unavailable',
      )
    return r.json()
  }
  return partner
}

export function wageDestination(env = process.env) {
  const call = partnerClient(env)
  return (command, reconcile) => reconcile
    ? call('/requests/'+encodeURIComponent(command.requestId)+'/receipt')
    : call('/requests', {requestId:command.requestId,workItemId:command.claimId,actorId:command.actorId,
        operationId:command.operationId,payloadDigest:command.payloadDigest,input:command.payload})
}

export function connectShowcase(domain, env = process.env) {
  const partner = partnerClient(env)
  async function getResult(requestId) {
    const result = await partner('/requests/' + encodeURIComponent(requestId))
    if (result.requestId !== requestId || !result.taskId || result.eventId !== 'wage-result:' + result.taskId)
      throw new DomainError(409, 'invalid_partner_result')
    return result
  }
  return {
    async activity(path, input) {
      if (path === 'wage/start') {
        const w = await domain.startWage(input)
        if (w.state !== 'awaiting-partner' || w.taskId) return w
        // Pre-upgrade registrations can only be recovered by lookup. New sends use reviewed operations.
        const result = await partner('/requests/' + encodeURIComponent(w.requestId) + '/registration')
        if (!result) return domain.closeUnregisteredWage(input)
        if (result.requestId !== w.requestId || result.workItemId !== w.workItemId)
          throw new DomainError(409, 'wrong_partner_task')
        return domain.bindPartnerTask(result)
      }
      if (path === 'wage/poll') {
        const w = await domain.wageStatus(input)
        if (w.state !== 'awaiting-partner') return w
        const r = await getResult(input.requestId)
        if (r.state === 'completed') await domain.admitPartnerNotice(r)
        return w
      }
      if (path === 'wage/accept') {
        const w = await domain.wageStatus(input)
        if (w.state !== 'awaiting-partner') return w
        const r = await getResult(input.requestId)
        if (r.state !== 'completed' || r.eventId !== input.eventId || !r.artifact)
          throw new DomainError(409, 'invalid_partner_result')
        return domain.acceptWage(r)
      }
    },
    async release(ctx, itemId, requestId) {
      const detail = await domain.detail(ctx, itemId)
      if (!detail.canAct) throw new DomainError(403, 'read_only')
      if (!detail.wages.some((w) => w.requestId === requestId && w.taskId && w.state === 'awaiting-partner'))
        throw new DomainError(409, 'partner_task_pending')
      return partner('/requests/' + encodeURIComponent(requestId) + '/release', {})
    },
    async receive(req, body) {
      if (req.method !== 'POST') throw new DomainError(405, 'method_not_allowed')
      const path = new URL(req.url, 'http://local').pathname
      if (path === '/claims/integrations/showcase/voice') {
        if (!hasBearer(req, env.SHOWCASE_VOICE_TOKEN)) throw new DomainError(403, 'forbidden')
        const b = await body(req)
        if (b.eventId !== 'voice-IN-201' || b.documentId !== 'IN-201-call')
          throw new DomainError(400, 'invalid_voice_event')
        return domain.deliverShowcaseIntake()
      }
      if (path !== '/claims/integrations/showcase/partner' || !hasBearer(req, env.SHOWCASE_PARTNER_TOKEN))
        throw new DomainError(403, 'forbidden')
      return domain.admitPartnerNotice(await body(req))
    },
    async deliver(ctx) {
      if (!['maya', 'supervisor'].includes(ctx.principalId) && !ctx.roles?.includes('claims_admin')) throw new DomainError(403, 'forbidden')
      const r = await fetch('http://voice:3092/demo/replay', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + env.SHOWCASE_VOICE_TOKEN },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) throw new DomainError(503, 'voice_service_unavailable')
      return r.json()
    },
    mcp: (ctx, itemId, rpc) => timelineRpc(domain, ctx, itemId, rpc),
    async media(ctx, itemId, id, format, req, res, recheck) {
      const doc = await domain.document(ctx, itemId, id)
      const audio = format === 'audio' && itemId === 'IN-201' && id === 'IN-201-call'
      if (format !== 'pdf' && !audio) throw new DomainError(404, 'not_found')
      const bytes = audio
        ? await readFile(new URL('./assets/IN-201-call.wav', import.meta.url))
        : renderDocumentPdf(doc)
      recheck()
      const headers = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-type': audio ? 'audio/wav' : 'application/pdf',
        'content-disposition': 'inline; filename="' + id + (audio ? '.wav' : '.pdf') + '"',
      }
      if (audio) headers['accept-ranges'] = 'bytes'
      const range = audio && req.headers.range
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range)
        const start = match ? Number(match[1]) : -1,
          end = match?.[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1
        if (start < 0 || start > end) {
          res.writeHead(416, { ...headers, 'content-range': 'bytes */' + bytes.length }).end()
          return
        }
        res
          .writeHead(206, {
            ...headers,
            'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length,
            'content-length': end - start + 1,
          })
          .end(bytes.subarray(start, end + 1))
      } else res.writeHead(200, { ...headers, 'content-length': bytes.length }).end(bytes)
    },
  }
}
