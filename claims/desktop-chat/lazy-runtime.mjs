import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'

/** One employee volume, one private runtime. The caller acquires a lease only after authentication. */
export function lazyRuntime(start, { idleMs = 15 * 60_000 } = {}) {
  let current, pending, stopping, timer, closed = false, leases = 0, generation = 0
  function schedule() {
    clearTimeout(timer)
    if (closed || leases || !current || stopping) return
    const handle = current, observed = generation
    timer = setTimeout(async () => {
      const idle = await handle.idle().catch(() => false)
      if (observed !== generation || handle !== current || closed || leases) return
      if (idle) {
        current = undefined
        stopping = handle.stop().finally(() => { stopping = undefined })
        await stopping
      } else schedule()
    }, idleMs)
    timer.unref()
  }
  async function acquire() {
    clearTimeout(timer)
    generation++
    leases++
    let released = false
    const release = () => { if (!released) { released = true; leases--; schedule() } }
    try {
      if (stopping) await stopping
      if (closed) throw new Error('Managed chat stopped')
      if (!current && !pending) {
        pending = start().then(handle => {
          current = handle
          void handle.exited.then(() => { if (current === handle) current = undefined })
          return handle
        }).finally(() => { pending = undefined })
      }
      const handle = current || await pending
      if (closed) throw new Error('Managed chat stopped')
      return { ...handle.connection, release }
    } catch (error) { release(); throw error }
  }
  return { acquire, async close() {
    closed = true
    clearTimeout(timer)
    await pending?.catch(() => {})
    if (current) await current.stop()
    await stopping
  } }
}

export async function startPrivateRuntime(spawnNative, pair) {
  const child = spawnNative()
  const exited = once(child, 'exit').catch(() => {})
  let finished = false
  void exited.then(() => { finished = true })
  async function stop() {
    if (!finished) child.kill('SIGTERM')
    const deadline = setTimeout(() => { if (!finished) child.kill('SIGKILL') }, 10000)
    deadline.unref()
    try { await exited } finally { clearTimeout(deadline) }
  }
  const starting = new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (line.startsWith('dsh web: http://127.0.0.1:')) resolve(line.slice('dsh web: '.length))
    })
    lines.once('close', () => reject(new Error('Private runtime ended before pairing')))
  })
  const deadline = setTimeout(() => child.kill('SIGTERM'), 90000)
  try {
    const connection = await pair(await starting)
    return { connection, exited, stop, idle: () => new Promise(resolve => {
      if (!child.connected || finished) return resolve(false)
      const id = randomUUID()
      const done = value => { clearTimeout(timeout); child.off('message', message); resolve(value) }
      const message = result => { if (result?.idleProbe === id) done(result.idle === true) }
      const timeout = setTimeout(() => done(false), 2000)
      child.on('message', message)
      child.send({ idleProbe: id }, error => { if (error) done(false) })
    }) }
  } catch (error) { await stop(); throw error }
  finally { clearTimeout(deadline) }
}
