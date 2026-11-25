import { createHash, timingSafeEqual } from 'node:crypto'
import { DomainError } from '../domain/index.mjs'

// These are synthetic sources, not live partner endpoints. Caller data cannot select scope or content.
export const DEMO_SOURCE_BINDINGS = Object.freeze(Object.fromEntries([
  ['voice-intake', 'IN-201'], ['voice-team-intake', 'IN-202'], ['a2a-update', 'WC-102'], ['calendar-change', 'WC-101'],
  ['jira-update', 'WC-103'], ['ado-update', 'WC-102'],
].map(([source, itemId]) => [source, Object.freeze({ fixtureId: source, itemId, tenantId: 'demo', profileId: 'claims-v1' })])))
const hash = value => createHash('sha256').update(value).digest()
const fail = (status, code) => { throw new DomainError(status, code) }
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

/** Native WebServer handler for a dedicated service credential, independent of browser and worker identities. */
export function createFixtureIngress({ domain, token, workerToken }) {
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new TypeError('A dedicated fixture credential of at least 32 characters is required')
  if (workerToken && token === workerToken) throw new TypeError('Fixture and worker credentials must differ')
  const expected = hash('Bearer ' + token)
  return async function fixtureIngress(req, res) {
    try {
      if (new URL(req.url, 'http://localhost').pathname !== '/claims/integrations/fixtures') fail(404, 'not_found')
      if (req.method !== 'POST') fail(405, 'method_not_allowed')
      const authorization = req.headers.authorization
      if (typeof authorization !== 'string' || !timingSafeEqual(hash(authorization), expected)) fail(403, 'fixture_forbidden')
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'json_required')
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 2048) fail(413, 'request_too_large')
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail(400, 'invalid_json') }
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'eventId,source'
        || typeof body.source !== 'string' || !Object.hasOwn(DEMO_SOURCE_BINDINGS, body.source)
        || typeof body.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.eventId)) fail(400, 'invalid_fixture_envelope')
      const binding = DEMO_SOURCE_BINDINGS[body.source]
      const result = await domain.fixture({
        principalId: 'fixture-ingress', subject: 'service:fixture-ingress:' + body.source,
        tenantId: binding.tenantId, profileId: binding.profileId,
      }, { fixtureId: binding.fixtureId, eventId: body.eventId })
      res.writeHead(200, headers)
      res.end(JSON.stringify(result))
    } catch (error) {
      const known = error instanceof DomainError
      res.writeHead(known ? error.status : 503, headers)
      res.end(JSON.stringify({ code: known ? error.code : 'fixture_unavailable' }))
    }
  }
}
