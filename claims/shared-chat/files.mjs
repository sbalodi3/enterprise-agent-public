// This program runs inside the employee sandbox.
import { readFile, readdir, realpath, stat, rename, writeFile, unlink } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
const request = JSON.parse(process.argv[2])
const root = '/workspace'
if (typeof request.path !== 'string' || request.path.includes('\0') || request.path.startsWith('/') ||
    request.path.split('/').some(part=>part==='..')) throw Error('Invalid workspace path')
const path = resolve(root,request.path)
const inside = async target => {
  const resolved = await realpath(target)
  if (resolved !== root && !resolved.startsWith(root+sep)) throw Error('Path outside workspace')
  return resolved
}
let result
if (request.action === 'write') {
  if (path===root || typeof request.text !== 'string' || Buffer.byteLength(request.text)>200000) throw Error('Invalid file content')
  const parent=await inside(dirname(path)),temp=resolve(parent,'.chat-'+randomUUID())
  try {
    await writeFile(temp,request.text,{flag:'wx',mode:0o600})
    await rename(temp,resolve(parent,basename(path)))
  } finally {await unlink(temp).catch(err=>{if(err.code!=='ENOENT')throw err})}
  result={saved:true}
} else if(request.action==='list') {
  const entries=await readdir(await inside(path),{withFileTypes:true})
  result={entries:entries.filter(e=>e.isFile()||e.isDirectory()).map(e=>({name:e.name,directory:e.isDirectory()})).sort((a,b)=>a.name.localeCompare(b.name))}
} else if(request.action==='read') {
  const resolved=await inside(path),info=await stat(resolved)
  if(!info.isFile()||info.size>2*1024*1024)throw Error('File exceeds preview size')
  result={data:(await readFile(resolved)).toString('base64')}
} else throw Error('Unsupported file operation')
process.stdout.write(JSON.stringify(result))
