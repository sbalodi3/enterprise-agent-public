// Offline volume migration. Each invocation has one immutable input and exclusive staging destinations.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, readFile, writeFile, rename, link, unlink, realpath, readdir, symlink } from 'node:fs/promises'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { createRequire } from 'node:module'
import { employeeProvider } from './model-profiles.mjs'
import { personalPreferences } from './settings.mjs'
import { employeeTools } from './employee-mcp.mjs'
import { inventory } from './inventory.mjs'
import { probeImage } from '../../packages/attachment/attachment-local/lib/types/image.js'
import { sessionDir } from '../../packages/session/session-persistence-jsonl/lib/types/format.js'

import { scanZstdFrames } from '../../packages/session/session-persistence-jsonl/lib/types/zstd.js'

const yaml = createRequire(new URL('../../packages/boot/config-editor/package.json',import.meta.url))('yaml')
const logName = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
const uuid = /^[a-f0-9]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const missing = err => { if (err.code !== 'ENOENT') throw err }
const get = path => readFile(path).catch(missing)
async function dir(path) {
  await mkdir(path,{recursive:true,mode:0o700})
  if (await realpath(path) !== resolve(path)) throw Error('Unsafe directory: ' + path)
}
async function put(path, bytes, replace = false) {
  await dir(dirname(path))
  const existing = await lstat(path).catch(missing)
  if (existing) {
    if (!existing.isFile()) throw Error('Unsafe destination: ' + path)
    if (hash(await readFile(path)) === hash(bytes)) return
    if (!replace) throw Error('Destination conflict: ' + path)
  }
  const tmp = path + '.' + randomUUID()
  await writeFile(tmp,bytes,{flag:'wx',mode:0o600})
  try {
    if (replace) await rename(tmp,path)
    else await link(tmp,path)
    if (hash(await readFile(path)) !== hash(bytes)) throw Error('Copy verification failed')
  } finally { await unlink(tmp).catch(missing) }
}
const json = (path, data, replace) => put(path, Buffer.from(JSON.stringify(data) + '\n'), replace)
function decode(bytes, name) {
  let raw = bytes
  let encodedEvents
  if (name.endsWith('.zstd')) {
    const {frames,tornStart} = scanZstdFrames(bytes)
    if (!frames.length || tornStart !== undefined) throw Error('Incomplete native Zstandard log')
    raw = zstdDecompressSync(bytes.subarray(0, frames[0].end), {maxOutputLength: 1024*1024})
    if (raw.indexOf(10) !== raw.length-1) throw Error('Invalid native header frame')
    encodedEvents = bytes.subarray(frames[0].end)
  }
  const lf = raw.indexOf(10)
  if (lf < 0) throw Error('Incomplete native header')
  const header = JSON.parse(raw.subarray(0,lf).toString())
  if (header.type !== 'session' || typeof header.id !== 'string') throw Error('Invalid native header')
  const events = encodedEvents?.length ? zstdDecompressSync(encodedEvents, {maxOutputLength:512*1024*1024}) : raw.subarray(lf+1)
  return { header, events, encodedEvents }
}
function relocate(log, name, cwd) {
  const header = Buffer.from(JSON.stringify({...log.header,cwd})+'\n')
  if (!name.endsWith('.zstd')) return Buffer.concat([header,log.events])
  const frame = zstdCompressSync(header, {params:{[constants.ZSTD_c_checksumFlag]:1}})
  return Buffer.concat([frame,log.encodedEvents])
}
const blankRegistry = () => ({unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[],archivedSessionIds:[],pinnedSessionIds:[]},tables:{workspaces:{}}})
async function registryAt(path) {
  const bytes = await get(path), value = bytes ? JSON.parse(bytes.toString()) : blankRegistry()
  if (value.unit?.name !== 'workspace' || value.unit.version !== 2 || value.global.pendingMutation) throw Error('Workspace registry needs review')
  return value
}
async function copyEntry(root, target, file) {
  if (file.kind === 'directory') return dir(target)
  if (file.kind === 'link') throw Error('Workspace symlink needs operator review: ' + file.path)
  const bytes = await readFile(join(root,file.path))
  if (hash(bytes) !== file.sha256) throw Error('Source changed during migration: ' + file.path)
  await put(target,bytes)
}
function checkRoots(roots) {
  if (roots.some((path,i) => roots.some((other,j) => i !== j && (path === other || path.startsWith(other + sep))))) throw Error('Volume copies overlap')
}
export async function importEmployee({legacy,home,workspace,logicalHome,deployment,manifest,registry}) {
  const {subject} = manifest
  if (!uuid.test(subject) || !uuid.test(deployment) || !logicalHome.startsWith('/')) throw Error('Invalid deployment or subject')
  checkRoots(await Promise.all([legacy,home,workspace].map(path=>realpath(path))))
  const current = await inventory(legacy,subject)
  if (current.issues.length || !isDeepStrictEqual(current,manifest)) throw Error('Inventory changed or has unresolved issues')
  const privateRoot = join(home,'native-chat',deployment,subject)
  const source = 'harness/' + subject, wsfile = 'storages/workspace.json'
  const old = await registryAt(join(legacy,source,wsfile)), shared = await registryAt(join(home,wsfile))
  const evidence = new Map(manifest.files.filter(file=>file.kind === 'file').map(file=>[file.path,file.sha256]))
  const mappings = [], logs = []
  for (const ws of manifest.workspaces) {
    if (!uuid.test(ws.id) || !ws.path.startsWith('/data/harness/') || ws.path.startsWith('/data/harness/' + subject) ||
        ws.path === '/data/harness/') throw Error('Data and configuration roots require an explicit mapping')
    const standard = ['/data/harness/Documents','/data/harness/Documents/deepseek-harness/default-workspace'].includes(ws.path), slot = standard ? 'Documents' : ws.id
    const logical = join(logicalHome,'native-chat',deployment,subject,slot)
    const record = {...old.tables.workspaces[ws.id],path:logical}
    const existing = shared.tables.workspaces[ws.id]
    if (existing && !isDeepStrictEqual(existing,record)) throw Error('Workspace ID conflict')
    await registry.bind(subject,'workspace',ws.id)
    for (const id of ws.sessionIds) await registry.bind(subject,'session',id)
    await dir(join(privateRoot,slot))
    shared.tables.workspaces[ws.id] = record
    mappings.push({...ws,logical,files:standard ? '' : '.workspaces/' + ws.id,from:ws.path.slice(6)})
  }
  const roots = mappings.some(item=>item.files==='') ? mappings : [...mappings,{from:'harness/Documents',files:''}]
  for (const item of roots) {
    for (const file of manifest.files.filter(f=>f.path.startsWith(item.from+'/'))) {
      const suffix = file.path.slice(item.from.length+1)
      if (!item.files && suffix.split('/')[0] === '.workspaces') throw Error('Reserved directory exists in source')
      await copyEntry(legacy,join(workspace,item.files,suffix),file)
    }
  }
  for (const file of manifest.files) {
    if (file.kind !== 'file' || !file.path.startsWith(source+'/')) continue
    const path = file.path.slice(source.length+1), name = path.split('/').at(-1)
    if (path.startsWith('attachments/')) {
      await copyEntry(legacy,join(home,path),file)
      const imageObject = /^attachments\/v1\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(path)
      if (imageObject) {
        if (imageObject[2]!==file.sha256 || !file.sha256.startsWith(imageObject[1])) throw Error('Invalid image digest')
        const {width,height,mediaType} = await probeImage(await readFile(join(legacy,file.path)))
        await registry.bindUpload(subject,'image',{attachmentId:'sha256:'+file.sha256,bytes:file.bytes,width,height,mediaType})
      }
      const match=/^attachments\/v1\/files\/([a-f0-9]{2})\/([a-f0-9]{64})\/([^/]+)$/.exec(path)
      if (match) {
        if (match[2]!==file.sha256 || !file.sha256.startsWith(match[1])) throw Error('Invalid attachment hash')
        await registry.bindUpload(subject,'file',{attachmentId:'sha256:'+file.sha256,name:match[3],bytes:file.bytes})
      }
    }
    else if (path.startsWith('sessions/') && logName.test(name)) {
      const bytes = await readFile(join(legacy,file.path))
      if (hash(bytes) !== file.sha256) throw Error('Native log changed')
      const log = decode(bytes,name)
      for (const path of attachmentPaths(log)) {
        const digest = path.includes('/files/') ? path.split('/').at(-2) : path.split('/').at(-1)
        if (evidence.get(source+'/'+path)!==digest) throw Error('Missing employee-owned evidence in '+log.header.id)
      }
      const ws = mappings.find(row=>row.sessionIds.includes(log.header.id)) ?? mappings.find(row=>row.path===log.header.cwd)
      if (!ws || log.header.cwd !== ws.path) throw Error('Ambiguous session workspace: ' + log.header.id)
      await registry.bind(subject,'session',log.header.id)
      const dest = join(sessionDir(join(home,'sessions'),ws.logical,log.header.id),name)
      await put(dest,relocate(log,name,ws.logical))
      if (!decode(await readFile(dest),name).events.equals(log.events)) throw Error('Native events differ')
      logs.push({id:log.header.id,original:file.path,shared:relative(home,dest),eventsHash:hash(log.events)})
    } else if (path.startsWith('profiles/') || path.startsWith('storages/') || path === 'settings.yaml') {
      await copyEntry(legacy,join(privateRoot,'legacy-settings',path),file)
    }
  }
  const preferences = new Map()
  for (const patch of ['profiles/claims-desktop-chat/cordis.patch.yml','cordis.patch.yml']) {
    const profile = await get(join(legacy,source,patch))
    if (!profile) continue
    await put(join(privateRoot,'legacy-settings',patch),profile)
    for (const [ns,section] of personalPreferences(yaml.parse(profile.toString()))) preferences.set(ns,{...preferences.get(ns),...section})
    for (const [name,config] of employeeTools(profile.toString())) await registry.bindTool(subject,name,config)
  }
  for (const [ns,section] of preferences) await registry.bindPreferences(subject,ns,section)
  for (const key of ['workspaceIds','pinnedSessionIds','archivedSessionIds'])
    shared.global[key] = [...new Set([...(shared.global[key]??[]),...(old.global[key]??[])])]
  await json(join(home,wsfile),shared,true)
  const report = {version:1,deployment,subject,sourceHash:hash(JSON.stringify(manifest)),mappings,logs}
  await json(join(privateRoot,'migration.json'),report)
  return report
}

async function* walk(root, prefix = '') {
  for (const item of await readdir(join(root,prefix),{withFileTypes:true})) {
    const path = join(prefix,item.name)
    yield {path,dir:item.isDirectory(),file:item.isFile(),link:item.isSymbolicLink()}
    if (item.isDirectory()) yield* walk(root,path)
  }
}
function attachmentPaths(log) {
  const paths = new Set()
  for (const line of log.events.toString().split('\n')) {
    if (!line) continue
    const e = JSON.parse(line)
    const messages = e.type === 'user/message' ? [e.data] : e.type === 'agent/inbox/spliced' ? e.data.inserted ?? []
      : ['assistant/message','tool/result','developer/message','system/message'].includes(e.type) ? [e.data.message] : []
    for (const msg of messages) for (const block of msg?.content ?? []) {
      if (!['image','file'].includes(block.type)) continue
      const ref = block.attachment
      const sha = /^sha256:([0-9a-f]{64})$/.exec(ref?.attachmentId)?.[1]
      if (!sha) throw Error('Unrecognized attachment in employee history')
      paths.add(join('attachments/v1',block.type === 'image' ? 'objects' : 'file-objects',sha.slice(0,2),sha))
      if (block.type === 'file') {
        if (!ref.name || ['.','..'].includes(ref.name) || ref.name.includes('/') || ref.name.includes('\\')) throw Error('Invalid file reference')
        paths.add(join('attachments/v1/files',sha.slice(0,2),sha,ref.name))
      }
    }
  }
  return paths
}
/** Reconstruct a fresh legacy volume, including the employee's post-switch chats and files. */
export async function rollbackEmployee({legacy,restored,home,workspace,logicalHome,deployment,manifest,registry}) {
  const { subject } = manifest, src = 'harness/' + subject, wsfile = 'storages/workspace.json'
  checkRoots(await Promise.all([legacy,restored,home,workspace].map(path=>realpath(path))))
  if ((await readdir(restored)).length) throw Error('Restore requires an empty destination volume')
  const prefix = join(home,'native-chat',deployment,subject)
  const report = JSON.parse(await readFile(join(prefix,'migration.json'),'utf8'))
  if (report.subject !== subject || report.deployment !== deployment || report.sourceHash !== hash(JSON.stringify(manifest)) ||
      !isDeepStrictEqual(await inventory(legacy,subject),manifest)) throw Error('Rollback source or manifest changed')
  const old = await registryAt(join(legacy,src,wsfile)), shared = await registryAt(join(home,wsfile))
  const mappings = [...report.mappings]
  const owned = Object.entries(shared.tables.workspaces).filter(([id])=>registry.owner('workspace',id)===subject)
  for (const [id,record] of owned) {
    let map = mappings.find(ws=>ws.id===id)
    if (!map) {
      if (record.path !== join(logicalHome,'native-chat',deployment,subject,'Documents')) throw Error('Unknown new workspace')
      map = {id,logical:record.path,from:'harness/Documents',path:'/data/harness/Documents',files:''}
      mappings.push(map)
    }
    old.tables.workspaces[id] = {...record,path:map.path,sessionIds:record.sessionIds.filter(id=>registry.owner('session',id)===subject)}
  }
  old.global.workspaceIds = shared.global.workspaceIds.filter(id=>registry.owner('workspace',id)===subject)
  for (const key of ['pinnedSessionIds','archivedSessionIds']) old.global[key] = shared.global[key].filter(id=>registry.owner('session',id)===subject)
  const roots = mappings.length ? mappings.map(ws=>ws.from) : ['harness/Documents']
  for (const f of manifest.files) {
    if (roots.some(root=>f.path===root || f.path.startsWith(root+'/')) || f.path===src+'/'+wsfile ||
        (f.path.startsWith(src+'/sessions/') && (logName.test(f.path.split('/').at(-1)) || f.path.endsWith('/session.lock')))) continue
    const dest = join(restored,f.path)
    if (f.kind==='link') { await dir(dirname(dest)); await symlink(f.target,dest) }
    else await copyEntry(legacy,dest,f)
  }
  for (const map of mappings) await dir(join(restored,map.from))
  for await (const item of walk(workspace)) {
    const nested = item.path.split('/')
    if (item.path === '.workspaces') continue
    const map = nested[0] === '.workspaces' ? mappings.find(ws=>ws.files===nested.slice(0,2).join('/')) : undefined
    if (nested[0] === '.workspaces' && !map) throw Error('Unmapped workspace directory')
    const dest = join(restored,map?.from ?? mappings.find(ws=>!ws.files)?.from ?? 'harness/Documents',map ? nested.slice(2).join('/') : item.path)
    if (item.dir) await dir(dest)
    else if (item.file) await put(dest, await readFile(join(workspace,item.path)))
    else throw Error('Workspace symlink requires review: ' + item.path)
  }
  const found = new Set()
  const sessions = join(home,'sessions')
  for await (const item of ((await lstat(sessions).catch(missing)) ? walk(sessions) : [])) {
    const name = item.path.split('/').at(-1)
    if (!item.file || !logName.test(name)) continue
    const log = decode(await readFile(join(sessions,item.path)),name)
    if (registry.owner('session',log.header.id)!==subject) continue
    const map = mappings.find(ws=>ws.logical===log.header.cwd)
    if (!map) throw Error('Unmapped native session')
    if (log.header.agentPreset === 'employee-chat') delete log.header.agentPreset
    const dest = join(sessionDir(join(restored,src,'sessions'),map.path,log.header.id),name)
    await put(dest,relocate(log,name,map.path))
    found.add(log.header.id)
    for (const path of attachmentPaths(log)) {
      const bytes = await readFile(join(home,path))
      if (hash(bytes) !== (path.includes('/files/') ? path.split('/').at(-2) : path.split('/').at(-1))) throw Error('Attachment checksum mismatch')
      await put(join(restored,src,path),bytes)
    }
  }
  for (const upload of await registry.uploads(subject)) {
    const { kind,reference }=await registry.upload(subject,upload.id)
    const sha=reference.attachmentId.slice(7)
    const paths=[join('attachments/v1',kind==='image'?'objects':'file-objects',sha.slice(0,2),sha)]
    if (kind==='file') paths.push(join('attachments/v1/files',sha.slice(0,2),sha,reference.name))
    for (const path of paths) {
      const bytes=await readFile(join(home,path))
      if (hash(bytes)!==sha) throw Error('Upload checksum mismatch')
      await put(join(restored,src,path),bytes)
    }
  }
  if (report.logs.some(log=>!found.has(log.id))) throw Error('Missing previously imported session')
  await json(join(restored,src,wsfile),old)
  const changes = (await registry.preferences(subject)).filter(row => row.revision > 0)
  const updates = changes.map(({namespace, preferences}) => ({id: namespace, config: preferences}))
  // A session created on the shared service may still select this employee's model alias.
  // Use the server-generated binding so its native model selection remains usable on the legacy service.
  const sharedProfile = await get(join(home, 'profiles/claims-workbench/cordis.patch.yml'))
  if (sharedProfile) {
    const rows = yaml.parse(sharedProfile.toString())
    const id = employeeProvider(subject)
    const provider = rows.find(row => row.id === 'llm-pi-ai' && !row.disabled)?.config?.providers?.[id]
    if (provider) updates.push({id: 'llm-pi-ai', config: {providers: {[id]: provider}}})
  }
  if (updates.length) {
    const path=join(restored,src,'cordis.patch.yml')
    const original=await get(path), patches=original?yaml.parse(original.toString()):[]
    if (!Array.isArray(patches)) throw Error('Unrecognized employee patch during rollback')
    patches.push(...updates)
    await put(path,Buffer.from(yaml.stringify(patches)),true)
  }
  // Restore only a demonstrably launcher-generated root truncated by an out-of-space legacy boot.
  const profile = join(restored,src,'profiles/claims-desktop-chat')
  const root = await get(join(profile,'cordis.yml'))
  if (root?.length === 0) {
    const pkg = JSON.parse(await readFile(join(profile,'package.json'),'utf8'))
    const patch = await readFile(join(profile,'cordis.patch.yml'),'utf8')
    if (pkg.name !== 'dsh-profile-claims-desktop-chat' || !patch.startsWith('# Generated by claims/runtime/launch.mjs\n'))
      throw Error('Empty unmanaged profile requires review')
    await put(join(profile,'cordis.yml'),Buffer.from('[]\n'),true)
  }
  return {sessions:[...found].sort()}
}
