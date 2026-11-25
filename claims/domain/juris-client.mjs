/** Internal client for the configured mock JURIS. No browser-supplied host or credentials. */
export function createJurisClient({ url, token }) {
  const base = new URL(url)
  if (!['http:', 'https:'].includes(base.protocol) || !token) throw new Error('invalid_juris_configuration')
  async function call(path, command) {
    let response
    try {
      response = await fetch(new URL(path, base), {
        method: command ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { authorization: 'Bearer ' + token, ...(command && { 'content-type': 'application/json' }) },
        ...(command && { body: JSON.stringify(command) }),
      })
    } catch (cause) {
      throw Object.assign(new Error('mock_juris_unavailable', { cause }), {status:503,code:'juris_unavailable'})
    }
    if (!response.ok) {
      const result = await response.json().catch(() => ({}))
      const error = new Error('mock_juris_error')
      error.status = response.status
      error.code = ['stale_revision', 'operation_conflict'].includes(result.error)
        ? result.error
        : 'juris_unavailable'
      throw error
    }
    return response.json()
  }
  return {
    read: (id) => call('/v1/claims/' + encodeURIComponent(id)),
    apply: (command) => call('/v1/commands', command),
    receipt: (id) => call('/v1/receipts/' + encodeURIComponent(id)),
  }
}
