// Stage verified native data in separate engine volumes. This command never starts application writers.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { containerEngine, containerEnvironment } from './container-engine.mjs'
import { workspaceImage } from './shared-chat-compose.mjs'

const [mode, source] = process.argv.slice(2)
if (!source || !['import','rollback'].includes(mode)) throw Error('Use import|rollback INVENTORY_DIRECTORY')
const folder = resolve(source)
const manifest = JSON.parse(readFileSync(join(folder,'index.json')))
const {project,records} = manifest
if (!['claims-demo','enterprise-agent-showcase'].includes(project) || manifest.issues.length) throw Error('Unresolved deployment inventory')
const engine = containerEngine()
const env = containerEnvironment(engine)
const run = (args, options = {}) => execFileSync(engine,args,{encoding:'utf8',env,stdio:['ignore','pipe','inherit'],...options}).trim()
const ids = run(['ps','-aq','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.container-number']).split(/\s+/).filter(Boolean)
const containers = JSON.parse(run(['inspect',...ids]))
const service = c => c.Config.Labels['com.docker.compose.service']
const workbench = containers.find(c=>service(c)==='workbench')
const db = containers.find(c=>service(c)==='postgres')
if (!workbench || !db?.State.Running) throw Error('The deployment and PostgreSQL must exist')
const dbEnv = workbench.Config.Env.find(entry=>entry.startsWith('DATABASE_URL='))
if (!dbEnv) throw Error('Missing Workbench database binding')
const network = Object.keys(db.NetworkSettings.Networks).find(name=>name===project+'_claims')
if (!network) throw Error('Missing private claims network')
if (containers.some(c=>c.State.Running && (service(c)==='workbench' || service(c)==='workspace-manager' || service(c).startsWith('chat-'))))
  throw Error('Drain turns and stop Workbench, managers and employee Chat writers before transfer')
const label='org.enterprise-agent.workspace'
if (run(['ps','-q','--filter','label='+label+'='+project])) throw Error('Drain active workspace containers before transfer')
const stagedImage = mode === 'rollback' ? JSON.parse(readFileSync(join(folder,'staged.json'))).image : undefined
const image = process.env.CLAIMS_SHARED_CHAT_IMAGE || stagedImage || 'claims-workbench:local'
const indexHash = createHash('sha256').update(readFileSync(join(folder,'index.json'))).digest('hex').slice(0,16)
const shared = project+'-shared-chat-'+indexHash
const legacyWorkbench = project+'_claims-harness'
function volume(name, labels) {
  const exists = run(['volume','ls','--filter','name=^'+name+'$','--format','{{.Name}}']).split('\n').includes(name)
  if (!exists) run(['volume','create',...Object.entries(labels).flatMap(([k,v])=>['--label',k+'='+v]),name])
  const actual=JSON.parse(run(['volume','inspect',name]))[0]
  if (Object.entries(labels).some(([k,v])=>actual.Labels?.[k]!==v)) throw Error('Volume label mismatch: '+name)
}
const deploymentLabels={'org.enterprise-agent.chat-migration':indexHash}
const mount=(name,dest,ro=false) => ['--mount','type=volume,src='+name+',dst='+dest+(ro?',readonly':'')]
const fixed=['run','--rm','--pull=never','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges']
volume(shared,deploymentLabels)
if (mode==='import') {
  // The original Workbench also contains private service-agent logs. Keep them with Workbench without granting any employee ownership.
  const copy = `set -eu
    if test ! -e /data/.native-workbench-seeded; then
      cp -a /legacy/. /data/
      touch /data/.native-workbench-seeded
    fi`
  run([...fixed,'--network','none',...mount(shared,'/data'),...mount(legacyWorkbench,'/legacy',true),'--entrypoint','sh',image,'-ec',copy])
}
const restoredVolumes = {}
const batch = randomUUID().slice(0,8)
for (const record of records) {
  if (record.manifest!==record.subject+'.json' || !existsSync(join(folder,'snapshots',record.subject+'.tar'))) throw Error('Missing verified employee snapshot')
  const files=project+'-ws-'+createHash('sha256').update(record.subject).digest('hex').slice(0,32)+'-files'
  volume(files,{[label]:project,[label+'.subject']:record.subject})
  // Use the same image and target as the manager, so a newly created volume inherits the workspace ownership.
  run([...fixed,'--network','none',...mount(files,'/workspace'),'--entrypoint','true',workspaceImage])
  const mounts=[...mount(record.volume,'/legacy',true),...mount(shared,'/shared',mode==='rollback'),...mount(files,'/workspace',mode==='rollback')]
  if (mode==='rollback') {
    const restored=record.volume+'-restored-'+batch
    volume(restored,deploymentLabels)
    run([...fixed,'--network','none','--user','0:0','--cap-add','CHOWN',...mount(restored,'/restored'),'--entrypoint','chown',image,'1000:1000','/restored'])
    mounts.push(...mount(restored,'/restored'))
    restoredVolumes[record.volume.slice(project.length+1)]={name:restored,external:true}
  }
  const args=[...fixed,'-i','--network',network,...mounts,
    '-e','DATABASE_URL','--entrypoint','node',image,'claims/deploy/transfer-chat.mjs',mode,'-',record.principalId]
  run(args,{env:{...env,DATABASE_URL:dbEnv.slice('DATABASE_URL='.length)},input:JSON.stringify({index:manifest,manifest:JSON.parse(readFileSync(join(folder,record.manifest)))}),stdio:['pipe','pipe','inherit']})
  console.log(mode,record.principalId)
}
const path=join(folder,mode==='rollback'?'rollback.compose.json':'staged.json')
const result=mode==='rollback'?{volumes:restoredVolumes}:{project,shared,image,inventory:folder}
writeFileSync(path+'.tmp',JSON.stringify(result,null,2),{mode:0o600})
renameSync(path+'.tmp',path)
console.log(path)
