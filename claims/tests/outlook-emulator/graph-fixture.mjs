import { createServer } from 'node:http'
import { once } from 'node:events'

/** Add the Microsoft Search response contract to the synthetic lab. Collection reads
 * still run against the emulator with the caller's own delegated access token. */
export async function startGraphFixture(emulatorOrigin, { hostname = '127.0.0.1', port = 0 } = {}) {
  const server = createServer((req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
    async function handle() {
      const url = new URL(req.url, 'http://localhost')
      const headers = { authorization: req.headers.authorization || '', prefer: req.headers.prefer || '' }
      if (!headers.authorization.startsWith('Bearer ')) return send(401, { error: 'missing_token' })
      if (req.method === 'GET' && (/^\/v1\.0\/me\/messages(?:\/[^/]+)?$/.test(url.pathname) || url.pathname === '/v1.0/me/mailFolders/inbox/messages')) {
        const response = await fetch(emulatorOrigin + url.pathname + url.search, { headers, redirect: 'error' })
        const page = await response.json()
        if (page['@odata.nextLink']) {
          const next = new URL(page['@odata.nextLink'], emulatorOrigin)
          page['@odata.nextLink'] = next.pathname + next.search
        }
        return send(response.status, page)
      }
      if (req.method !== 'POST' || url.pathname !== '/v1.0/search/query') return send(404, { error: 'fixture_route_unknown' })
      const chunks = []
      let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > 16384) return send(413, { error: 'search_request_too_large' })
        chunks.push(chunk)
      }
      const [search] = JSON.parse(Buffer.concat(chunks).toString()).requests
      if (search?.entityTypes?.join() !== 'message' || search.enableTopResults !== false ||
        typeof search.query?.queryString !== 'string' || !Number.isInteger(search.from) || search.from < 0 ||
        !Number.isInteger(search.size) || search.size < 1 || search.size > 50) return send(400, { error: 'unsupported_search_contract' })
      const params = new URLSearchParams({ '$search': JSON.stringify(search.query.queryString), '$orderby':'receivedDateTime desc', '$top':'1000' })
      const response = await fetch(emulatorOrigin + '/v1.0/me/messages?' + params, { headers, redirect:'error' })
      const listing = await response.json()
      if (!response.ok) return send(response.status, listing)
      const selected = listing.value.slice(search.from, search.from + search.size)
      return send(200, { value:[{ hitsContainers:[{ total:selected.length, moreResultsAvailable: search.from + selected.length < listing.value.length,
        hits:selected.map((resource, i) => ({ hitId:resource.id, rank:search.from + i + 1, resource })) }] }] })
    }
    void handle().catch(() => send(502, { error: 'fixture_unavailable' }))
  })
  server.listen(port, hostname)
  await once(server, 'listening')
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) }
}
