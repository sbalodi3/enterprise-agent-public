import { DomainError } from '../domain/index.mjs'

// Only deployed, bounded operations may reach provider clients. Required sources
// come from server code, never a prompt, tool arguments, or the browser.
export const outlookOperations = Object.freeze({
  'outlook.search': Object.freeze(['outlook-mail']),
  'outlook.read': Object.freeze(['outlook-mail']),
})

export function createOperationGate({ operations, status, withAccess }) {
  return async function run(principal, operation, invoke, { expectedVersions = {}, signal } = {}) {
    const required = Object.hasOwn(operations, operation) ? operations[operation] : undefined
    if (!Array.isArray(required) || !required.length) throw new DomainError(403, 'connection_operation_denied')
    // Validate the full source set before acquiring a token or calling a provider.
    const states = await Promise.all(required.map(app => status(principal, app)))
    for (const state of states) {
      if (!state.available || state.status !== 'connected' ||
          (expectedVersions[state.id] !== undefined && expectedVersions[state.id] !== state.version))
        throw new DomainError(409, 'microsoft_connection_changed')
    }
    // Each enclosing lease rechecks its generation before releasing the result.
    // A disconnect in any source cancels the signal passed to the composite call.
    const leases = new Map()
    async function acquire(index, activeSignal) {
      if (index === states.length) return invoke(leases, activeSignal)
      const { id, version } = states[index]
      return withAccess(principal, id, lease => {
        leases.set(id, lease)
        return acquire(index + 1, lease.signal)
      }, { expectedVersion: version, signal: activeSignal })
    }
    return acquire(0, signal)
  }
}
