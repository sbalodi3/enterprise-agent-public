import { sharedOverlay, buildWorkspace, useSharedChat } from '../deploy/shared-chat-compose.mjs'
import { prepareCmsSnapshot } from './cms-mcp/prepare.mjs'
import { cmsChatServices, writeCmsChatCompose } from './cms-chat-compose.mjs'
import { demoIssuer, upgradeIssuer, stopLegacyIssuer } from '../deploy/entra-upgrade.mjs'
import { buildComposeImages, containerEngine, containerEnvironment } from '../deploy/container-engine.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { homedir } from 'node:os'

const root = fileURLToPath(new URL('../../', import.meta.url))
const flags = new Set(process.argv.slice(2))
const unified = flags.has('--app')
const project = unified ? 'enterprise-agent' : 'enterprise-agent-showcase'
const cache = join(root, '.artifacts', unified ? project : 'claims-showcase')
const appPort = unified ? 3280 : 3180
const issuerPort = unified ? 8280 : 8180
const appOrigin = 'http://127.0.0.1:' + appPort
const issuer = demoIssuer(true).replace(':8180/', ':' + issuerPort + '/')
const envFile = join(cache, '.env')
const engine = unified ? 'podman' : containerEngine()
if (
  [...flags].some(
    (flag) => !['--app', '--build', '--reset', '--model', '--stop', '--prepare', '--config', '--offline', '--observe', '--cms-mcp', '--no-cms-mcp', '--shared-chat'].includes(flag),
  )
)
  throw Error('Unknown showcase flag')
if (flags.has('--cms-mcp') && flags.has('--no-cms-mcp')) throw Error('Select one CMS-MCP dataset mode.')
mkdirSync(cache, { recursive: true, mode: 0o700 })
const cmsMarker = join(cache, 'cms-mcp.enabled')
const cmsEnabled = flags.has('--cms-mcp') || (!flags.has('--no-cms-mcp') && existsSync(cmsMarker))
const shutdown = flags.has('--reset') || flags.has('--stop')
function persistDatasetMode() {
  if (cmsEnabled) writeFileSync(cmsMarker, '1\n', { mode: 0o600 })
  else rmSync(cmsMarker, { force: true })
}
if (!existsSync(envFile)) {
  const creds = Object.fromEntries(
    [
      'CLAIMS_POSTGRES_PASSWORD',
      'CLAIMS_DB_PASSWORD',
      'CLAIMS_WORKER_TOKEN',
      'CLAIMS_SESSION_SECRET',
      'CLAIMS_OIDC_CLIENT_SECRET',
      'CLAIMS_FIXTURE_TOKEN',
      'JURIS_DB_PASSWORD',
      'JURIS_SERVICE_TOKEN',
      'SHOWCASE_VOICE_TOKEN',
      'SHOWCASE_PARTNER_TOKEN',
      'SHOWCASE_CALLBACK_TOKEN',
      'SHOWCASE_MOCK_CLIENT_SECRET',
    ].map((k) => [k, randomBytes(32).toString('hex')]),
  )
  Object.assign(creds, {
    ...(unified && process.env.CLAIMS_MODEL_URL && {CLAIMS_MODEL_URL: process.env.CLAIMS_MODEL_URL}),
    ...(unified && process.env.CLAIMS_MODEL_ID && {CLAIMS_MODEL_ID: process.env.CLAIMS_MODEL_ID}),
    CLAIMS_APP_ORIGIN: appOrigin,
    CLAIMS_OIDC_ISSUER: issuer,
    CLAIMS_TEMPORAL_ENABLED: 'true',
  })
  writeFileSync(
    envFile,
    Object.entries(creds)
      .map(([k, v]) => k + '=' + v)
      .join('\n') + '\n',
    { flag: 'wx', mode: 0o600 },
  )
}
// Existing demos keep their volumes and credentials when the private peer is introduced.
upgradeIssuer(envFile, true)
const settings = readFileSync(envFile, 'utf8')
const demoSecret = settings.match(/^CLAIMS_SESSION_SECRET=(.+)$/m)?.[1]
if (!demoSecret) throw Error('The existing showcase needs a local session secret')
const newCredentials = ['PORTFOLIO_A2A_TOKEN', 'PORTFOLIO_A2A_REVIEW_TOKEN']
  .filter(key => !new RegExp('^' + key + '=.+$', 'm').test(settings))
  .map(key => key + '=' + createHmac('sha256', demoSecret).update('department-peer/v1/' + key).digest('hex'))
if (newCredentials.length) appendFileSync(envFile, '\n' + newCredentials.join('\n') + '\n')

function run(bin, args, env = {}) {
  const r = spawnSync(bin, args, { cwd: root, stdio: 'inherit', env: containerEnvironment(engine, env) })
  if (r.error) throw r.error
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const pointer = join(cache, 'context-path')
const env = {
  SHOWCASE_APP_PORT: String(appPort), SHOWCASE_ISSUER_PORT: String(issuerPort),
  SHOWCASE_WIDGET_PORT: unified ? '4481' : '4381', SHOWCASE_TEMPORAL_PORT: unified ? '8433' : '8333',
  SHOWCASE_TRACING_PORT: unified ? '18686' : '17686',
  SHOWCASE_CMS_SNAPSHOT: join(cache, 'cms-mcp/snapshot.json'),
  SHOWCASE_PARTNER_CONTEXT: existsSync(pointer) ? readFileSync(pointer, 'utf8').trim() : cache,
  CLAIMS_SOURCE_COMMIT: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  CLAIMS_APP_ORIGIN: appOrigin,
  CLAIMS_OIDC_ISSUER: issuer,
  CLAIMS_TEMPORAL_ENABLED: 'true',
}
const compose = [
  'compose',
  '--project-name',
  project,
  '--env-file',
  envFile,
  '-f',
  'compose.claims.yml',
  '-f',
  'claims/showcase/compose.yml',
  '--profile',
  'story',
]
const storedSettings = parseEnv(settings)
const partnerSource = resolve(process.env.SHOWCASE_A2A_SOURCE || storedSettings.SHOWCASE_A2A_SOURCE ||
  join(homedir(), 'Documents/A2A/dev_a2a_aws'))
const partnerMode = process.env.SHOWCASE_PARTNER_MODE || storedSettings.SHOWCASE_PARTNER_MODE
if (partnerMode && !['fixture', 'signed-a2a'].includes(partnerMode)) throw Error('Invalid SHOWCASE_PARTNER_MODE')
const signedPartner = partnerMode ? partnerMode === 'signed-a2a'
  : !unified || flags.has('--prepare') || Boolean(process.env.SHOWCASE_A2A_SOURCE || storedSettings.SHOWCASE_A2A_SOURCE) ||
    existsSync(pointer) || existsSync(partnerSource)
if (signedPartner || shutdown) compose.push('--profile', 'signed-a2a')
if (!signedPartner) compose.push('-f', 'claims/showcase/partner/local.compose.yml')
if (unified) {
  const sessionSeconds = process.env.CLAIMS_AUTH_SESSION_SECONDS || storedSettings.CLAIMS_AUTH_SESSION_SECONDS || '43200'
  env.CLAIMS_AUTH_SESSION_SECONDS = sessionSeconds
  // Allow for token exchange and employee lookup before the 12-hour application timer starts.
  env.CLAIMS_AUTH_ID_TOKEN_SECONDS = String(Number(sessionSeconds) + 60)
}
const localOutlook = unified && !(process.env.CLAIMS_MS_MODE || storedSettings.CLAIMS_MS_MODE ||
  process.env.CLAIMS_MS_CLIENT_ID || storedSettings.CLAIMS_MS_CLIENT_ID)
if (localOutlook) {
  mkdirSync(join(cache, 'cms-mcp'), { recursive: true, mode: 0o700 })
  env.OUTLOOK_CMS_DATASET = cmsEnabled ? '1' : '0'
  compose.push('-f', 'claims/deploy/outlook.compose.yml')
}
if (cmsEnabled) compose.push('-f', 'claims/showcase/cms-mcp/compose.yml')
const shared = useSharedChat({cache,project,engine,requested:unified || flags.has('--shared-chat')})
if (shared) compose.push('-f', sharedOverlay({ project, cache, showcase: true, bookmarks: !unified, cms: cmsEnabled, engine, socket: process.env.CLAIMS_ENGINE_SOCKET }))
if (!shared) compose.push('--profile','legacy-employee-chat')
if (!shared && (cmsEnabled || shutdown || flags.has('--no-cms-mcp'))) compose.push('-f', writeCmsChatCompose(cache))
if (!shared && (cmsEnabled || shutdown)) compose.push('--profile', 'cms-chat')
const routerStaged = ['model.onnx', 'tokenizer.json', 'manifest.json'].every(name =>
  existsSync(join(root, '.artifacts/claims-router/model', name)),
)
if (routerStaged || flags.has('--reset') || flags.has('--stop')) compose.push('--profile', 'scope-model')
if (flags.has('--observe') || flags.has('--stop') || flags.has('--reset')) compose.push('--profile', 'observe')
if (flags.has('--observe')) env.CLAIMS_OTLP_ENDPOINT = 'http://collector:4318'
if (flags.has('--model') || (unified && !process.env.CLAIMS_MODEL_URL && !storedSettings.CLAIMS_MODEL_URL)) compose.push('--profile', 'model')
if (flags.has('--reset') || flags.has('--stop')) {
  run(
    engine,
    [...compose, '--profile', 'model', 'down', ...(flags.has('--reset') ? ['--volumes'] : [])],
    env,
  )
  process.exit(0)
}
if (flags.has('--config')) {
  run(engine, [...compose, 'config', '--quiet'], env)
  process.exit(0)
}
if (cmsEnabled) {
  const snapshot = prepareCmsSnapshot(join(cache, 'cms-mcp', 'snapshot.json'), process.env.CMS_MCP_SOURCE, engine)
  console.log('CMS-MCP dataset ready:', snapshot.rows.length, 'synthetic claims from six lines of business.')
}
if (!shared && flags.has('--no-cms-mcp') && !flags.has('--prepare'))
  run(engine, [...compose, '--profile', 'cms-chat', 'stop', ...cmsChatServices], env)
if (flags.has('--offline')) {
  if (!unified && !existsSync(pointer)) throw Error('Build the local showcase once before an offline launch.')
  stopLegacyIssuer(project, engine)
  run(engine, [...compose, 'up', '--pull', 'never', '--no-build', '-d', '--wait'], env)
  persistDatasetMode()
  console.log('Enterprise Agent', appOrigin + '/open-app')
  process.exit(0)
}
function missing(image) { return spawnSync(engine, ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0 }
function shouldBuild(image) {
  return !unified || flags.has('--build') || missing(image)
}
const buildPartner = signedPartner && shouldBuild('enterprise-agent-showcase-partner:local')
if (signedPartner && (buildPartner || flags.has('--prepare'))) {
  const directory = mkdtempSync(join(cache, 'build-'))
  env.SHOWCASE_PARTNER_CONTEXT = join(directory, 'context')
  run('python3', ['claims/showcase/partner/prepare.py', '--source', partnerSource, '--output', env.SHOWCASE_PARTNER_CONTEXT])
  writeFileSync(pointer, env.SHOWCASE_PARTNER_CONTEXT, { mode: 0o600 })
}
if (!flags.has('--prepare')) {
  const services = []
  if (unified ? shouldBuild('claims-workbench:local') : shared || missing('claims-workbench:local')) services.push('workbench')
  if (shouldBuild('claims-entra-local:0.1.1')) services.push('entra')
  if (buildPartner) services.push('partner-adapter')
  if (localOutlook && shouldBuild('localhost/enterprise-agent-outlook:v1')) services.push('outlook')
  if (routerStaged && shouldBuild('enterprise-agent-scope-router:local')) services.push('scope-router')
  const options = { cwd: root, stdio: 'inherit', env: containerEnvironment(engine, env) }
  if (shared && shouldBuild('localhost/claims-workspace-manager:v1')) services.push('workspace-manager')
  if (shared && shouldBuild('localhost/claims-workspace:v1')) buildWorkspace(engine, options)
  if (services.length) buildComposeImages(engine, compose, options, services)
  stopLegacyIssuer(project, engine)
  run(engine, [...compose, 'up', '-d', '--wait', '--no-build'], env)
  persistDatasetMode()
  console.log('Enterprise Agent', appOrigin + '/open-app')
}
