import { ApplicationFailure } from '@temporalio/common'

/** Activities use authenticated domain APIs; workers never connect to the claims database. */
export function createActivities({ workApiUrl, serviceToken, timeoutMs = 15000, fetchImpl = fetch }) {
  const base = new URL(workApiUrl)
  if (!['http:', 'https:'].includes(base.protocol) || !serviceToken) throw new Error('A work API URL and service token are required')
  const request = async (path, body) => {
    const response = await fetchImpl(new URL(`/api/internal/work/${path}`, base), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'content-type': 'application/json',
        'idempotency-key': `${path}:${body.operationId ?? body.requestId}:${body.eventId ?? ''}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      // Do not log response bodies: they can contain domain data or gateway diagnostics.
      const message = `Work API ${path} returned HTTP ${response.status}`
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
        throw ApplicationFailure.nonRetryable(message, 'WorkApiRejected')
      }
      throw ApplicationFailure.retryable(message, 'WorkApiUnavailable')
    }
    const result = await response.json()
    if (!result || typeof result.state !== 'string') throw ApplicationFailure.nonRetryable('Work API returned an invalid state envelope', 'WorkApiContract')
    return result
  }
  return {
    dispatchOperation: (input) => request('dispatch', input),
    reconcileOperation: (input) => request('reconcile', input),
    startWage: (input) => request('wage/start', input),
    acceptWage: (input) => request('wage/accept', input),
    pollWage: (input) => request('wage/poll', input),
    wageStatus: (input) => request('wage/status', input),
    timeoutWage: (input) => request('wage/timeout', input),
  }
}
