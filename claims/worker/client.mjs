import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client'

const safeId = (value, field) => {
  const limit = field === 'workflowId' ? 200 : 160
  if (typeof value !== 'string' || value.length > limit || !/^[A-Za-z0-9_.:-]+$/.test(value)) throw new Error(`${field} must be a bounded opaque identifier`)
  return value
}
const validateTimeouts = (input) => {
  for (const field of ['partnerTimeoutMs', 'reviewTimeoutMs', 'reconciliationTimeoutMs']) {
    if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || input[field] < 1 || input[field] > 2592000000)) throw new Error(`${field} must be between 1 ms and 30 days`)
  }
  return input
}

/** Called by trusted gateway code after checking request/work-item ownership and current access. */
export async function submitClient({ address = 'temporal:7233', namespace = 'default', taskQueue = 'claims-work' } = {}) {
  const connection = await Connection.connect({ address })
  const client = new Client({ connection, namespace })
  const start = async (type, workflowId, input) => {
    try {
      const handle = await client.workflow.start(type, {
        workflowId, taskQueue, args: [validateTimeouts(input)],
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      })
      return { workflowId, runId: handle.firstExecutionRunId, alreadyStarted: false, closed: false }
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
      const description = await client.workflow.getHandle(workflowId).describe()
      return { workflowId, runId: description.runId, alreadyStarted: true, closed: Boolean(description.closeTime) }
    }
  }
  const operationId = (id) => `claims-operation-${safeId(id, 'operationId')}`
  const wageId = (id) => `claims-wage-${safeId(id, 'requestId')}`
  return {
    submit: (input) => start('executeReviewedOperation', operationId(input.operationId), input),
    startWage: (input) => { safeId(input.workItemId, 'workItemId'); return start('wageEvidenceRequest', wageId(input.requestId), input) },
    requestReconciliation: (id) => client.workflow.getHandle(operationId(id)).signal('reconcileRequested'),
    signalWageEvidence: ({ requestId, eventId }) => client.workflow.getHandle(wageId(requestId)).signal('evidenceReceived', { eventId: safeId(eventId, 'eventId') }),
    signalWageReview: (requestId) => client.workflow.getHandle(wageId(requestId)).signal('humanReviewed'),
    reconcileWage: (requestId) => client.workflow.getHandle(wageId(requestId)).signal('reconcileRequested'),
    status: (workflowId) => client.workflow.getHandle(safeId(workflowId, 'workflowId')).query('status'),
    result: (workflowId) => client.workflow.getHandle(safeId(workflowId, 'workflowId')).result(),
    close: () => connection.close(),
  }
}
