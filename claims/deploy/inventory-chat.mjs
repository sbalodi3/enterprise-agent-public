import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { containerEngine, containerEnvironment } from './container-engine.mjs'
import { directory } from '../auth/roster.mjs'

const { values } = parseArgs({ options: { project: { type: 'string' }, output: { type: 'string' } } })
if (!['claims-demo', 'enterprise-agent-showcase'].includes(values.project) || !values.output)
  throw Error('Supply --project claims-demo or enterprise-agent-showcase and --output DIRECTORY.')
const engine = containerEngine(), project = values.project
const run = (args, input) => execFileSync(engine, args, { input, encoding: 'utf8', env: containerEnvironment(engine),
  timeout: 120000, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe','pipe','inherit'] }).trim()
const volumes = run(['volume','ls','--filter','label=com.docker.compose.project=' + project, '--format','{{.Name}}']).split('\n').filter(Boolean)
const services = run(['ps','-a','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.container-number',
  '--format','{{.Names}}']).split('\n').filter(Boolean)
const cms = project === 'enterprise-agent-showcase' && (services.some(n=>n.includes('chat-cms-adjuster-')) ||
  volumes.some(n=>n.includes('chat-cms-adjuster-')) || process.env.CLAIMS_CMS_MCP === '1')
const known = directory(project === 'enterprise-agent-showcase', cms).employees.filter(person => person.profile === 'claims-v1')
const owners = new Map(known.map(person => [(person.principalId.startsWith('cms-') || person.principalId === 'claims-admin' ? 'chat-' : 'claims-chat-') + person.principalId, person]))
const helper = await readFile(new URL('../shared-chat/inventory.mjs', import.meta.url), 'utf8')
await mkdir(resolve(values.output), { recursive: true, mode: 0o700 })
const stage = await mkdtemp(join(resolve(values.output), project + '-'))
const records = [], issues = []
for (const volume of volumes.sort()) {
  const logical = run(['volume','inspect','--format','{{index .Labels "com.docker.compose.volume"}}',volume])
  if (!/^(?:claims-)?chat-/.test(logical)) continue
  const person = owners.get(logical)
  if (!person) { issues.push('Unknown volume owner: ' + volume); continue }
  if (records.some(record => record.subject === person.subject)) throw Error('Ambiguous employee volume')
  const raw = run(['run','--rm','--pull=never','-i','--network','none','--read-only','--cap-drop=ALL',
    '-e','CLAIMS_INVENTORY_SUBJECT=' + person.subject,'--mount','type=volume,src=' + volume + ',dst=/input,readonly',
    '--entrypoint','node','claims-workbench:local','--input-type=module','-'], helper)
  const manifest = JSON.parse(raw)
  const filename = person.subject + '.json'
  await writeFile(join(stage, filename), raw + '\n', { mode: 0o600, flag: 'wx' })
  records.push({ principalId: person.principalId, subject: person.subject, volume, manifest: filename })
  for (const issue of manifest.issues) issues.push(person.principalId + ': ' + issue)
}
for (const person of known) if (!records.some(record=>record.subject===person.subject))
  issues.push('Missing legacy volume: ' + person.principalId)
for (const container of services) {
  const config = JSON.parse(run(['inspect','--format','{{json .Mounts}}',container]))
  const data = config.find(m=>m.Destination==='/data')
  const role = run(['inspect','--format','{{index .Config.Labels "com.docker.compose.service"}}',container])
  if (!owners.has(role) && !owners.has('claims-'+role)) continue
  const owner = owners.get(role) ?? owners.get('claims-'+role)
  if (!records.some(record=>record.subject===owner.subject && data?.Name===record.volume)) issues.push('Unexpected data mount: '+container)
  for (const mount of config) if (mount.Destination !== '/data' && (mount.RW || !mount.Destination?.startsWith('/app/deepseek-harness/claims/')))
    issues.push('Review external mount on '+container+' at '+mount.Destination)
}
if (!records.length) throw Error('No legacy Chat volumes found for ' + project)
const index = { project, engine, createdAt: new Date().toISOString(), records, issues }
await writeFile(join(stage, 'index.tmp'), JSON.stringify(index, null, 2) + '\n', { mode: 0o600 })
await rename(join(stage, 'index.tmp'), join(stage, 'index.json'))
console.log(stage, records.length, 'employee volumes,', issues.length, 'issues')
if (issues.length) process.exitCode = 2
