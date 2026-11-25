import { sharedOverlay, buildWorkspace, useSharedChat } from './shared-chat-compose.mjs'
import { stopLegacyIssuer } from './entra-upgrade.mjs'
import { buildComposeImages, composeConfig, containerEngine, containerEnvironment } from './container-engine.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.argv.includes('--showcase')) {
  process.argv = process.argv.filter(arg => arg !== '--showcase')
  await import('../showcase/launch.mjs')
  process.exit(0)
}
const known = new Set(['--story', '--observe', '--model', '--no-build', '--build-only', '--shared-chat'])
for (const arg of process.argv.slice(2)) if (!known.has(arg)) throw new Error(`Unknown option ${arg}`)
const selected = process.argv.slice(2)
if (selected.includes('--build-only') && selected.includes('--no-build')) throw new Error('Choose --build-only or --no-build.')
const engine = containerEngine()
await import('./init-env.mjs')
const profiles = ['story', 'observe', 'model'].filter(profile => selected.includes(`--${profile}`))
const args = ['compose', '--env-file', 'claims/deploy/.env', '-f', 'compose.claims.yml']
const shared = useSharedChat({cache:'.artifacts/claims-baseline',project:'claims-demo',engine,requested:selected.includes('--shared-chat')})
if (shared) args.push('-f', sharedOverlay({ project: 'claims-demo', cache: '.artifacts/claims-baseline', engine,
  socket: process.env.CLAIMS_ENGINE_SOCKET }))
if (!shared) args.push('--profile','legacy-employee-chat')
for (const profile of profiles) args.push('--profile', profile)
const options = {
  cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit',
  env: containerEnvironment(engine, {
    CLAIMS_SOURCE_COMMIT: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' }).trim(),
    CLAIMS_TEMPORAL_ENABLED: profiles.includes('story') ? 'true' : 'false',
    CLAIMS_OTLP_ENDPOINT: profiles.includes('observe') ? 'http://collector:4318' : '',
  }),
}
const project = composeConfig(engine, args, options)
if (shared && !selected.includes('--no-build')) buildWorkspace(engine, options)
if (!selected.includes('--no-build')) buildComposeImages(engine, args, options, undefined, project)
if (selected.includes('--build-only')) process.exit(0)
stopLegacyIssuer(project.name, engine)
const child = spawn(engine, [...args, 'up', '-d', '--wait', '--no-build'], options)
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
