import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { submitClient } from '../worker/client.mjs'
import { containerEngine, containerEnvironment } from './container-engine.mjs'

const workflowId = process.argv[2]
if (!workflowId) throw new Error('Usage: node claims/deploy/check-restart.mjs <waiting-workflow-id>')
const root = fileURLToPath(new URL('../../', import.meta.url))
const engine = containerEngine()
const run = args => new Promise((resolve, reject) => {
  const child = spawn(engine, ['compose', '--env-file', 'claims/deploy/.env', '-f', 'compose.claims.yml', '--profile', 'story', ...args], {
    cwd: root, stdio: 'inherit', env: containerEnvironment(engine),
  })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${engine} compose exited ${code}`)))
})
let client = await submitClient({ address: '127.0.0.1:7233' })
const before = await client.status(workflowId)
if (!['awaiting-partner', 'awaiting-review', 'awaiting-reconciliation'].includes(before.phase)) throw new Error('Choose a workflow waiting for a signal; this check must not interrupt an active external write')
await client.close()
await run(['restart', 'temporal', 'worker'])
const deadline = Date.now() + 60000
while (true) {
  try {
    client = await submitClient({ address: '127.0.0.1:7233' })
    const after = await client.status(workflowId)
    await client.close()
    if (after.phase !== before.phase) throw new Error(`Workflow phase changed unexpectedly: ${before.phase} -> ${after.phase}`)
    console.log(`Persisted workflow ${workflowId} resumed in ${after.phase}. No signal or write was submitted by this check.`)
    break
  } catch (error) {
    await client?.close().catch(() => {})
    if (Date.now() > deadline) throw error
    await delay(1000)
  }
}
