import { execFileSync } from 'node:child_process'
import { closeSync, openSync, mkdirSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { containerEngine, containerEnvironment } from './container-engine.mjs'
const folder = resolve(process.argv[2])
const index = JSON.parse(readFileSync(join(folder,'index.json')))
if (!['claims-demo','enterprise-agent-showcase'].includes(index.project) || index.issues.length) throw Error('Use an inventoried deployment with every owner resolved')
const engine=containerEngine(),dest=join(folder,'snapshots')
mkdirSync(dest,{recursive:true,mode:0o700})
for (const record of index.records) {
  const target=join(dest,record.subject+'.tar')
  if (existsSync(target)) continue
  const temp=target+'.'+randomUUID(),fd=openSync(temp,'wx',0o600)
  try {
    execFileSync(engine,['run','--rm','--pull=never','--network','none','--read-only','--cap-drop=ALL',
      '--mount','type=volume,src='+record.volume+',dst=/input,readonly','--entrypoint','tar','claims-workbench:local',
      '--hard-dereference','-C','/input','-cf','-','.'],{env:containerEnvironment(engine),stdio:['ignore',fd,'inherit'],timeout:120000})
  } finally {closeSync(fd)}
  // Read archive members without extracting them. Check every regular file and link before publication.
  execFileSync('python3',['-c',`
import tarfile,json,sys,hashlib
def digest(stream):
 h=hashlib.sha256()
 for block in iter(lambda: stream.read(1024*1024),b''): h.update(block)
 return h.hexdigest()
manifest=json.load(open(sys.argv[2])); expected={f['path']:f for f in manifest['files']}; seen=set()
with tarfile.open(sys.argv[1]) as tar:
 for item in tar:
  name=item.name.removeprefix('./').rstrip('/')
  if name in ('','.'):continue
  row=expected[name]
  assert name not in seen
  seen.add(name)
  if item.isfile():
   assert row['kind']=='file' and digest(tar.extractfile(item))==row['sha256']
  elif item.isdir(): assert row['kind']=='directory'
  elif item.issym(): assert row['kind']=='link' and item.linkname==row['target']
  else: raise ValueError('Unsupported member '+name)
assert seen==set(expected)
`,temp,join(folder,record.manifest)],{stdio:'inherit'})
  renameSync(temp,target)
}
console.log(index.project,index.records.length,'verified employee snapshots')
