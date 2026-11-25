/** Synthetic department agreement over the A2A 0.3 JSON-RPC binding. */
export const SKILL = 'legal.expense-authorization'
export const peerUrl = 'http://legal-agent:3092'
export const cardPath = '/.well-known/agent-card.json'
const uuid = /^HO-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export function handoffId(id) {
  return typeof id === 'string' && uuid.test(id)
}
export function taskId(id) {
  return 'authorization-' + id
}
export function contextId(id) {
  return 'billing-' + id
}

export function card(origin) {
  return {
    protocolVersion: '0.3.0',
    version: '1.0.0',
    name: 'Legal Matters',
    description: 'Resolve an approved synthetic expense authorization inquiry.',
    url: origin + '/a2a',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { financeService: { type: 'http', scheme: 'bearer' } },
    security: [{ financeService: [] }],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: SKILL,
        name: 'Check an expense authorization',
        description: 'Return the reviewed disposition and shareable authorization reference.',
        tags: ['billing', 'legal'],
      },
    ],
  }
}

export function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    keys.length === Object.keys(value).length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

export function requestData(row) {
  return {
    skill: SKILL,
    financeId: row.financeId,
    matterId: row.matterId,
    invoiceRef: row.invoiceRef,
    expenseRef: row.expenseRef,
    amountCents: row.amountCents,
  }
}

export function validRequest(data) {
  return (
    exact(data, ['skill', 'financeId', 'matterId', 'invoiceRef', 'expenseRef', 'amountCents']) &&
    data.skill === SKILL &&
    data.financeId === 'FIN-207' &&
    data.matterId === 'MAT-017' &&
    data.invoiceRef === 'INV-318' &&
    data.expenseRef === 'EXP-044' &&
    data.amountCents === 60000
  )
}

export function validReply(data) {
  return (
    exact(data, ['disposition', 'reference']) &&
    data.disposition === 'no_amendment' &&
    data.reference === 'AUTH-600-01'
  )
}
