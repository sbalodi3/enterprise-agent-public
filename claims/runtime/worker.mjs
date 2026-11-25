import { readFile } from 'node:fs/promises'
export const name = 'claims-worker'
export async function apply(ctx) {
  const { startWorker } = await import('../worker/index.mjs')
  const serviceToken =
    process.env.CLAIMS_WORKER_TOKEN ||
    process.env.WORKER_API_TOKEN ||
    (process.env.WORKER_API_TOKEN_FILE && (await readFile(process.env.WORKER_API_TOKEN_FILE, 'utf8')).trim())
  const worker = await startWorker({
    address: process.env.TEMPORAL_ADDRESS || 'temporal:7233',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'claims-work',
    workApiUrl: process.env.WORK_API_URL || 'http://workbench:3080',
    serviceToken,
  })
  let stopping = false
  ctx.effect(
    () => async () => {
      stopping = true
      await worker.stop()
    },
    'claims: workflow worker',
  )
  worker.done.catch((error) => {
    if (!stopping) {
      console.error('Claims worker stopped:', error.message)
      process.exitCode = 1
      process.kill(process.pid, 'SIGTERM')
    }
  })
}
