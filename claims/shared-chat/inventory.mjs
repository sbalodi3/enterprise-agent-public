import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { join, posix, relative, resolve, sep } from 'node:path'

/** Inventory a single read-only legacy /data volume without executing its profiles or following links. */
export async function inventory(root, subject) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(subject)) throw Error('Invalid workspace subject')
  const files = [], sessions = new Set(), issues = []
  const home = 'harness/' + subject
  async function visit(folder) {
    for (const entry of (await readdir(join(root, folder), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const path = posix.join(folder, entry.name)
      const absolute = join(root, path)
      if (entry.isDirectory()) {
        files.push({ path, kind: 'directory' })
        await visit(path)
      } else if (entry.isSymbolicLink()) {
        files.push({ path, kind: 'link', target: await readlink(absolute) })
      } else if (entry.isFile()) {
        const before = await lstat(absolute), hash = createHash('sha256')
        for await (const chunk of createReadStream(absolute)) hash.update(chunk)
        const after = await lstat(absolute)
        if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) issues.push('File changed during inventory: ' + path)
        files.push({ path, kind: 'file', bytes: after.size, sha256: hash.digest('hex') })
        if (path.startsWith(home + '/sessions/') && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry.name)) sessions.add(posix.basename(folder).replace(/~([A-F0-9]{4})/g, (_all, hex) => String.fromCharCode(parseInt(hex,16))))
      } else issues.push('Unsupported entry: ' + path)
    }
  }
  await visit('')
  for (const file of files) {
    if (file.path.startsWith('harness/') && /^[\da-f-]{36}$/i.test(file.path.split('/')[1]) && file.path.split('/')[1] !== subject)
      issues.push('Additional employee home: ' + file.path.split('/')[1])
  }
  const registry = home + '/storages/workspace.json'
  const workspaces = []
  if (files.some(file => file.path === registry && file.kind === 'file')) {
    const data = JSON.parse(await readFile(join(root, registry), 'utf8'))
    if (!data.tables?.workspaces || !Array.isArray(data.global?.workspaceIds)) throw Error('Unrecognized workspace registry')
    for (const [id, item] of Object.entries(data.tables.workspaces)) {
      const path = item.path
      workspaces.push({ id, path, sessionIds: item.sessionIds })
      if (typeof path !== 'string' || !Array.isArray(item.sessionIds) || !item.sessionIds.every(id => typeof id === 'string'))
        throw Error('Invalid workspace record')
      if (!path.startsWith('/data/') || posix.normalize(path) !== path) {
        issues.push('Workspace outside employee volume: ' + id)
        continue
      }
      try {
        const target = await realpath(join(root, path.slice(6)))
        const distance = relative(await realpath(root), target)
        if (distance === '..' || distance.startsWith('..' + sep)) issues.push('Workspace resolves outside employee volume: ' + id)
      } catch { issues.push('Workspace directory unavailable: ' + id) }
    }
  } else if (files.some(item => item.path.startsWith(home + '/sessions/'))) issues.push('Session store has no workspace registry')
  const ids = new Set(workspaces.flatMap(item=>item.sessionIds))
  for (const id of ids) if (!sessions.has(id)) issues.push('Registered session log missing: ' + id)
  if (files.some(file => file.path === registry && file.kind !== 'file')) issues.push('Unexpected workspace registry entry')
  for (const item of workspaces) {
    const prefix = typeof item.path === 'string' && item.path.startsWith('/data/') ? item.path.slice(6) + '/' : undefined
    if (prefix && files.some(f=>f.kind==='link' && f.path.startsWith(prefix))) issues.push('Review workspace symlink: ' + item.id)
  }
  return { version: 1, subject, files, sessionIds: [...sessions].sort(), workspaces, issues: [...new Set(issues)].sort() }
}

if (process.argv[1] === '-' && process.env.CLAIMS_INVENTORY_SUBJECT)
  process.stdout.write(JSON.stringify(await inventory(resolve('/input'), process.env.CLAIMS_INVENTORY_SUBJECT)))
