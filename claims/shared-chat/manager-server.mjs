import { createServer } from 'node:http'
import { chmod, chown, mkdir, unlink } from 'node:fs/promises'
import { attachManagerStreams } from './duplex.mjs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineClient, workspaceManager } from './workspace-manager.mjs'

export const socket = '/run/chat-manager/workspace.sock'
const maxInput = 256 * 1024
/** The engine multiplexes stdout and stderr into length-prefixed frames. */
function output(buffer) {
  const chunks = []
  for (let offset = 0; offset < buffer.length;) {
    if (buffer.length - offset < 8 || ![1,2].includes(buffer[offset])) throw Error('Invalid engine output')
    const length = buffer.readUInt32BE(offset + 4)
    offset += 8
    if (length > buffer.length - offset) throw Error('Incomplete engine output')
    chunks.push(buffer.subarray(offset, offset + length))
    offset += length
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function commandService({ engine, manager, journal }) {
  journal.exec(`CREATE TABLE IF NOT EXISTS runs (
    subject TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, result TEXT,
    PRIMARY KEY(subject,operation))`)
  const reserve = journal.prepare('INSERT INTO runs(subject,operation,payload) VALUES(?,?,?) ON CONFLICT DO NOTHING')
  const find = journal.prepare('SELECT payload,result FROM runs WHERE subject=? AND operation=?')
  const complete = journal.prepare('UPDATE runs SET result=? WHERE subject=? AND operation=?')
  return async ({ subject, operation, command }) => {
    if (typeof subject !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(subject) ||
        typeof operation !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(operation) ||
        typeof command !== 'string' || !command.length || Buffer.byteLength(command) > maxInput || command.includes('\0'))
      throw Error('Invalid workspace operation')
    if (!reserve.run(subject, operation, command).changes) {
      const previous = find.get(subject, operation)
      if (previous.payload !== command) throw Error('Operation already reserved with different inputs')
      if (!previous.result) throw Error('Operation is running or was interrupted. Inspect the workspace before retrying.')
      return JSON.parse(previous.result)
    }
    let lease
    try {
      lease = await manager.acquire(subject)
      const exec = await engine('POST','/containers/' + lease.id + '/exec', {
        AttachStdout: true, AttachStderr: true, Tty: false, User: '1000:1000', WorkingDir: '/workspace',
        Cmd: ['timeout', '-k', '5', '300', '/bin/sh', '-c', command],
      })
      const raw = await engine('POST', '/exec/' + exec.Id + '/start', { Detach: false, Tty: false }, { timeout: 315000, bytes: true })
      const status = await engine('GET', '/exec/' + exec.Id + '/json')
      if (status.Running || !Number.isInteger(status.ExitCode)) throw Error('Workspace operation interrupted')
      const result = { output: output(raw), exitCode: status.ExitCode }
      complete.run(JSON.stringify(result), subject, operation)
      return result
    } finally { lease?.release() }
  }
}

export async function startManager({ path = socket, socketGid, state, engineSocket, engine, project, image }) {
  await mkdir(state, { recursive: true, mode: 0o700 })
  const journal = new DatabaseSync(join(state, 'commands.sqlite'))
  const manager = workspaceManager({ engine, project, image })
  await manager.reconcile()
  const run = commandService({ engine, manager, journal })
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    try {
      if (!['/run','/files','/approval'].includes(req.url) || req.method !== 'POST') { res.writeHead(404).end(); return }
      let size = 0
      const chunks = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxInput + 2048) { res.writeHead(413).end(); return }
        chunks.push(chunk)
      }
      const message=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url === '/approval') {
        const lease = await manager.acquire(message.subject, { existingOnly: true })
        if (!lease) { res.writeHead(204).end(); return }
        if (res.destroyed) { lease.release(); return }
        res.once('close', lease.release)
        res.writeHead(200)
        res.flushHeaders()
        return
      }
      let result
      if (req.url === '/files') {
        const lease=await manager.acquire(message.subject)
        try {
          const exec=await engine('POST','/containers/'+lease.id+'/exec',{User:'1000:1000',WorkingDir:'/workspace',
            AttachStdout:true,AttachStderr:true,Cmd:['node','/opt/workspace-files.mjs',JSON.stringify(message.file)]})
          const raw=await engine('POST','/exec/'+exec.Id+'/start',{Detach:false,Tty:false},{bytes:true})
          if ((await engine('GET','/exec/'+exec.Id+'/json')).ExitCode !== 0) throw Error('File operation failed')
          result=JSON.parse(output(raw))
        } finally { lease.release() }
      } else result=await run(message)
      res.end(JSON.stringify(result))
    } catch { res.writeHead(409).end(JSON.stringify({ error: 'Workspace tool failed or was interrupted. Check your files before retrying.' })) }
  })
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  if (engineSocket) attachManagerStreams(server, { engineSocket, engine, manager })
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  await new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve))
  if (socketGid !== undefined) await chown(path, 0, socketGid)
  await chmod(path, 0o660)
  const timer = setInterval(() => { void manager.reap().catch(() => console.error('Workspace idle check failed')) }, 30000)
  return { async close() { clearInterval(timer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); journal.close() } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manager = await startManager({ socketGid: 1000, engineSocket: '/run/engine.sock', state: '/var/lib/chat-manager', engine: engineClient('/run/engine.sock'),
    project: process.env.CLAIMS_DEPLOYMENT, image: process.env.CLAIMS_WORKSPACE_IMAGE })
  process.once('SIGTERM', () => { void manager.close() })
}
