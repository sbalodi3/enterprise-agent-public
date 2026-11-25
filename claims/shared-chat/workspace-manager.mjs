import http from 'node:http'
import { createHash } from 'node:crypto'

const idleMs = 15 * 60 * 1000
const label = 'org.enterprise-agent.workspace'
const limit = 4 * 1024 * 1024
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

/** Docker-compatible local API, including rootless Podman. */
export function engineClient(socketPath) {
  return function request(method, path, json, { timeout = 30000, bytes = false } = {}) {
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json))
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path,
        headers: body && { 'Content-Type': 'application/json', 'Content-Length': body.length },
        signal: AbortSignal.timeout(timeout),
      }, res => {
        let size = 0
        const chunks = []
        res.on('error', reject)
        res.on('data', chunk => {
          size += chunk.length
          if (size > limit) req.destroy(Error('Engine response too large'))
          else chunks.push(chunk)
        })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(Object.assign(Error('Container engine returned ' + res.statusCode), { status: res.statusCode }))
            return
          }
          const data = Buffer.concat(chunks)
          try { resolve(bytes ? data : data.length ? JSON.parse(data) : null) } catch (error) { reject(error) }
        })
      })
      req.on('error', reject)
      req.end(body)
    })
  }
}

/** One deterministic name per deployment and employee, with serialized lifecycle transitions. */
export function workspaceManager({ engine, project, image, clock = Date.now, idle = idleMs }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project) || !image) throw Error('Missing workspace deployment')
  const locks = new Map(), active = new Map()
  const nameFor = subject => {
    if (!uuid.test(subject)) throw Error('Invalid employee subject')
    return project + '-ws-' + createHash('sha256').update(subject).digest('hex').slice(0,32)
  }
  async function locked(name, operation) {
    const prior = locks.get(name) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(operation)
    locks.set(name, next)
    try { return await next } finally { if (locks.get(name) === next) locks.delete(name) }
  }
  async function inspect(name) {
    try { return await engine('GET', '/containers/' + name + '/json') }
    catch (error) { if (error.status === 404) return null; throw error }
  }
  function verify(container, subject, name) {
    const labels = container.Config.Labels
    const mounts = container.Mounts.filter(mount => mount.Type === 'volume' || mount.Type === 'bind')
    if (nameFor(subject) !== name || labels?.[label] !== project || labels?.[label + '.subject'] !== subject || container.Config.Image !== image ||
        mounts.length !== 1 || mounts[0].Name !== name + '-files' || mounts[0].Destination !== '/workspace')
      throw Error('Workspace reservation belongs to a different configuration')
  }
  async function acquire(subject, { existingOnly = false } = {}) {
    const name = nameFor(subject)
    return locked(name, async () => {
      let container = await inspect(name)
      if (existingOnly && !container?.State.Running) return null
      if (!container) {
        const labels = { [label]: project, [label + '.subject']: subject }
        const volume = await engine('POST', '/volumes/create', { Name: name + '-files', Labels: labels })
        if (volume.Labels?.[label] !== project || volume.Labels?.[label + '.subject'] !== subject)
          throw Error('Workspace volume owner mismatch')
        try {
          await engine('POST', '/containers/create?name=' + name, {
            Image: image, User: '1000:1000', WorkingDir: '/workspace', Labels: labels,
            Entrypoint: ['node'], Cmd: ['-e',"process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 3600000)"],
            Env: ['HOME=/workspace'], HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true,
              CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: 128, NanoCpus: 1000000000,
              Memory: 512 * 1024 * 1024, Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m' },
              Mounts: [{ Type: 'volume', Source: name + '-files', Target: '/workspace' }] },
          })
        } catch (error) { if (error.status !== 409) throw error }
        container = await inspect(name)
      }
      if (!container) throw Error('Workspace creation interrupted')
      verify(container, subject, name)
      if (!container.State.Running) await engine('POST', '/containers/' + container.Id + '/start')
      const state = active.get(name) ?? { count: 0, last: clock(), id: container.Id }
      state.id = container.Id
      state.count++
      active.set(name, state)
      let released = false
      return { id: state.id, release() {
        if (!released) { released = true; state.count--; state.last = clock() }
      } }
    })
  }
  async function reconcile() {
    const filters = encodeURIComponent(JSON.stringify({ label: [label + '=' + project] }))
    const containers = await engine('GET', '/containers/json?all=true&filters=' + filters)
    for (const container of containers) {
      const subject = container.Labels[label + '.subject'], name = nameFor(subject)
      if (!container.Names.includes('/' + name) && !container.Names.includes(name)) throw Error('Unexpected workspace name')
      if (container.State === 'running' && !active.has(name)) active.set(name, { id: container.Id, count: 0, last: clock() })
    }
  }
  async function reap() {
    for (const name of active.keys()) await locked(name, async () => {
      const state = active.get(name)
      if (!state || state.count || clock() - state.last < idle) return
      const container = await inspect(state.id)
      if (container?.State.Running) {
        verify(container, container.Config.Labels[label + '.subject'], name)
        // Podman also reports completed exec IDs until the container stops.
        for (const id of container.ExecIDs ?? []) {
          try { if ((await engine('GET', '/exec/' + id + '/json')).Running) return }
          catch (error) { if (error.status !== 404) throw error }
        }
        await engine('POST', '/containers/' + state.id + '/stop?t=5')
      }
      active.delete(name)
    })
  }
  return { acquire, reap, reconcile }
}
