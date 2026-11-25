import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow'

const activities = proxyActivities({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '10 seconds', maximumAttempts: 4 },
})
export const evidenceReceived = defineSignal('evidenceReceived')
export const humanReviewed = defineSignal('humanReviewed')
export const reconcileRequested = defineSignal('reconcileRequested')
export const statusQuery = defineQuery('status')

async function finishOperation(input, status, reconciliation) {
  status.operationId = input.operationId
  status.phase = 'dispatching'
  let result = await activities.dispatchOperation(input)
  const deadline = Date.now() + (input.reconciliationTimeoutMs ?? 86400000)
  while (result.state === 'unknown') {
    status.phase = 'awaiting-reconciliation'
    const awakened = await condition(() => reconciliation.requested, Math.max(1, deadline - Date.now()))
    if (!awakened) return { ...result, requiresReconciliation: true }
    reconciliation.requested = false
    result = await activities.reconcileOperation({ operationId: input.operationId })
  }
  status.phase = result.state
  return result
}

/** Executes a reviewed operation; unknown results only move through explicit reconciliation. */
export async function executeReviewedOperation(input) {
  const status = { phase: 'submitted', operationId: input.operationId }
  const reconciliation = { requested: false }
  setHandler(statusQuery, () => status)
  setHandler(reconcileRequested, () => { reconciliation.requested = true })
  const result = await finishOperation(input, status, reconciliation)
  status.phase = result.state
  return result
}

/** A bounded fixture wage request: partner event -> validation -> human review -> receipt. */
export async function wageEvidenceRequest(input) {
  const status = { phase: 'starting', requestId: input.requestId, workItemId: input.workItemId }
  const evidence = []
  const seenEvents = new Set()
  const reconciliation = { requested: false }
  let reviewRequested = false
  setHandler(statusQuery, () => status)
  setHandler(evidenceReceived, ({ eventId }) => {
    if (!seenEvents.has(eventId)) { seenEvents.add(eventId); evidence.push(eventId) }
  })
  setHandler(humanReviewed, () => { reviewRequested = true })
  setHandler(reconcileRequested, () => { reconciliation.requested = true })
  const started = await activities.startWage({ requestId: input.requestId, workItemId: input.workItemId })
  if (['stale', 'rejected', 'timed-out', 'confirmed'].includes(started.state)) {
    status.phase = started.state
    return started
  }
  status.phase = 'awaiting-partner'
  const partnerDeadline = Date.now() + (input.partnerTimeoutMs ?? 259200000)
  while (!evidence.length) {
    const remaining = Math.max(1, partnerDeadline - Date.now())
    const wait = input.pollPartner ? Math.min(30_000, remaining) : remaining
    if (!await condition(() => evidence.length > 0 || reviewRequested, wait)) {
      if (input.pollPartner && Date.now() < partnerDeadline) {
        const current = await activities.pollWage({ requestId: input.requestId })
        if (['stale','rejected','timed-out','confirmed'].includes(current.state)) return current
        continue
      }
      status.phase = 'timed-out'
      return activities.timeoutWage({ requestId: input.requestId, stage: 'partner' })
    }
    if (reviewRequested) {
      reviewRequested = false
      const current = await activities.wageStatus({ requestId: input.requestId })
      if (['stale', 'rejected', 'timed-out', 'confirmed'].includes(current.state)) {
        status.phase = current.state
        return current
      }
    }
  }
  status.phase = 'validating'
  await activities.acceptWage({ requestId: input.requestId, eventId: evidence.shift() })
  status.phase = 'awaiting-review'
  const reviewDeadline = Date.now() + (input.reviewTimeoutMs ?? 604800000)
  let reviewed = await activities.wageStatus({ requestId: input.requestId })
  while (!['approved', 'rejected', 'timed-out', 'confirmed', 'unknown', 'stale'].includes(reviewed.state)) {
    if (!await condition(() => reviewRequested, Math.max(1, reviewDeadline - Date.now()))) {
      status.phase = 'timed-out'
      return activities.timeoutWage({ requestId: input.requestId, stage: 'review' })
    }
    reviewRequested = false
    reviewed = await activities.wageStatus({ requestId: input.requestId })
  }
  if (!reviewed.operationId || ['rejected', 'timed-out', 'stale'].includes(reviewed.state)) {
    status.phase = reviewed.state
    return reviewed
  }
  const result = await finishOperation({ operationId: reviewed.operationId, reconciliationTimeoutMs: input.reconciliationTimeoutMs }, status, reconciliation)
  status.phase = result.state
  return result
}
