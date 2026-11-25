// Record a successful, already-running cutover so subsequent launcher invocations use its volume and image.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containerEngine, containerEnvironment } from './container-engine.mjs'
import { activationMarker } from './shared-chat-compose.mjs'
const root=fileURLToPath(new URL('../../',import.meta.url))
const staged=JSON.parse(readFileSync(join(resolve(process.argv[2]),'staged.json')))
const engine=containerEngine(), env=containerEnvironment(engine)
if (!['claims-demo','enterprise-agent-showcase'].includes(staged.project)) throw Error('Unknown deployment')
const run=args=>execFileSync(engine,args,{encoding:'utf8',env}).trim()
const workbench=JSON.parse(run(['inspect',staged.project+'-workbench-1']))[0]
if (!workbench.State.Running || workbench.State.Health?.Status!=='healthy' || workbench.Config.Image!==staged.image ||
    !workbench.Config.Env.includes('CLAIMS_SHARED_CHAT=1') || !workbench.Mounts.some(m=>m.Name===staged.shared && m.Destination==='/data'))
  throw Error('Verify the running shared Workbench before recording activation')
if(process.env.CLAIMS_SEARCH_NETWORK) {
  if(!Object.hasOwn(workbench.NetworkSettings.Networks,process.env.CLAIMS_SEARCH_NETWORK)) throw Error('Missing employee search network')
  staged.searchNetwork=process.env.CLAIMS_SEARCH_NETWORK
}
const cache=join(root,'.artifacts',staged.project==='claims-demo'?'claims-baseline':'claims-showcase')
mkdirSync(cache,{recursive:true,mode:0o700})
const marker=activationMarker(cache,engine)
writeFileSync(marker+'.tmp',JSON.stringify(staged,null,2),{mode:0o600})
renameSync(marker+'.tmp',marker)
console.log('Activated shared Chat for '+staged.project)
