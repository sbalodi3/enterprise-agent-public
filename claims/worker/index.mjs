import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeConnection, Worker } from '@temporalio/worker'
import { createActivities } from './activities.mjs'
import { submitClient } from './client.mjs'

export { submitClient } from './client.mjs'

/** Cordis profile plugin owns this handle and awaits stop() when its fiber is disposed. */
export async function startWorker({
  address = 'temporal:7233', namespace = 'default', taskQueue = 'claims-work',
  workApiUrl, serviceToken, dispatchPollMs = 2000, onError = (error) => console.error('Claims outbox polling failed:', error.message),
}) {
  if (!Number.isSafeInteger(dispatchPollMs) || dispatchPollMs < 100) throw new Error('dispatchPollMs must be at least 100')
  const activities = createActivities({ workApiUrl, serviceToken })
  const controller = new AbortController()
  const api = async (path, body) => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
    const response = await fetch(new URL(`/api/internal/work/${path}`, workApiUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
    })
    if (!response.ok) {
      const error = new Error(`Work outbox returned HTTP ${response.status}`)
      error.fatal = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)
      throw error
    }
    return response.json().catch(() => { throw Object.assign(new Error('Work API returned invalid JSON'), { fatal: true }) })
  }
  const readOutbox = async (path, field) => {
    const body = await api(path)
    if (!Array.isArray(body?.items) || body.items.length > 1000 || body.items.some((item) => typeof item?.[field] !== 'string')) {
      throw Object.assign(new Error('Work outbox returned an invalid batch'), { fatal: true })
    }
    return body.items
  }
  // Fail startup on a broken API/token contract instead of appearing to run with no work.
  await readOutbox('dispatchable', 'operationId')
  await readOutbox('wage/pending', 'deliveryId')
  const connection = await NativeConnection.connect({ address })
  let worker
  let submitter
  try {
    submitter = await submitClient({ address, namespace, taskQueue })
    worker = await Worker.create({ connection, namespace, taskQueue,
      workflowsPath: fileURLToPath(new URL('./workflows.mjs', import.meta.url)), activities,
      maxConcurrentActivityTaskExecutions: 4, maxConcurrentWorkflowTaskExecutions: 4,
      shutdownGraceTime: '15 seconds',
    })
  } catch (error) {
    await submitter?.close()
    await connection.close()
    throw error
  }
  const workerRun = worker.run()
  const poll = async () => {
    while (!controller.signal.aborted) {
      try {
        const items = await readOutbox('dispatchable', 'operationId')
        for (const item of items) {
          if (controller.signal.aborted) break
          await submitter.submit({ operationId: item.operationId, ...(item.simulateLostAck !== undefined ? { simulateLostAck: item.simulateLostAck } : {}) })
        }
        for (const item of await readOutbox('wage/pending', 'deliveryId')) {
          if (controller.signal.aborted) break
          if (!['start', 'evidence', 'review'].includes(item.kind)) throw Object.assign(new Error('Wage outbox returned an invalid delivery kind'), { fatal: true })
          const started = await submitter.startWage({ requestId: item.requestId, workItemId: item.workItemId, ...(process.env.CLAIMS_SHOWCASE === '1' && { pollPartner: true }) })
          if (!started.closed) {
            if (item.kind === 'evidence') await submitter.signalWageEvidence({ requestId: item.requestId, eventId: item.eventId })
            if (item.kind === 'review') await submitter.signalWageReview(item.requestId)
          }
          // A crash before this ACK redelivers a stable workflow ID or a deduplicated signal.
          await api('wage/delivered', { deliveryId: item.deliveryId })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error.fatal) throw error
          onError(error)
        }
      }
      if (!controller.signal.aborted) {
        try { await delay(dispatchPollMs, undefined, { signal: controller.signal }) }
        catch (error) { if (error.name !== 'AbortError') throw error }
      }
    }
  }
  const polling = poll()
  workerRun.finally(() => controller.abort()).catch(() => {})
  polling.catch(() => { if (worker.getState() === 'RUNNING') worker.shutdown() })
  const done = Promise.all([workerRun, polling]).then(() => undefined).finally(() => controller.abort())
  // A profile caller observes `done`; prevent a transient unhandled rejection before registration.
  done.catch(() => {})
  let stopping
  return {
    done,
    stop() {
      return stopping ??= (async () => {
        controller.abort()
        if (worker.getState() === 'RUNNING') worker.shutdown()
        const results = await Promise.allSettled([workerRun, polling])
        try {
          const failure = results.find(result => result.status === 'rejected')
          if (failure) throw failure.reason
        } finally {
          try { await submitter.close() } finally { await connection.close() }
        }
      })()
    },
  }
}
