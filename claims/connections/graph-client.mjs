import { setTimeout as delay } from 'node:timers/promises'
import { DomainError } from '../domain/index.mjs'

/** Server-side Graph transport for approved operations on the signed-in employee's behalf. */
export function createGraphClient(lease, options = {}) {
  const origin = new URL(lease.graphOrigin || options.origin || 'https://graph.microsoft.com').origin
  const fetcher = options.fetch || globalThis.fetch
  async function request(path, init = {}) {
    const url = new URL(path, origin)
    if (url.origin !== origin || !url.pathname.startsWith('/v1.0/')) throw new DomainError(502, 'invalid_graph_page')
    const signals = [AbortSignal.timeout(15000)]
    if (lease.signal) signals.push(lease.signal)
    const signal = AbortSignal.any(signals)
    async function send() {
      await lease.check()
      signal.throwIfAborted()
      return fetcher(url, {
        ...init, signal, redirect: 'error',
        headers: { ...init.headers, authorization: 'Bearer ' + lease.token, 'content-type': 'application/json' },
      })
    }
    let res = await send()
    if (res.status === 429) {
      const retry = res.headers.get('retry-after')
      if (retry !== null && /^\d+$/.test(retry) && Number(retry) <= 2) {
        await res.body?.cancel()
        await delay(Number(retry) * 1000, undefined, { signal })
        res = await send()
      }
    }
    if (!res.ok) {
      await res.body?.cancel()
      const known = {
        401: 'microsoft_reconnect_required',
        403: 'graph_access_denied',
        404: 'graph_resource_unavailable',
        429: 'graph_throttled',
      }
      throw new DomainError(known[res.status] ? res.status : 502, known[res.status] || 'graph_service_unavailable')
    }
    return res.json()
  }
  return { origin, request }
}
