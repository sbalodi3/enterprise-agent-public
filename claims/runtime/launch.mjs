// Materialize isolated demo profiles, then run the repository's supported dsh launcher.
import { mkdir, readFile, writeFile, symlink, realpath, lstat, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContainerAddress } from './bind-address.mjs'
import { inferenceProvider } from './model-config.mjs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { MANAGED_CHAT_PORTS } from '../desktop-chat/modes.mjs'
import { directory } from '../auth/roster.mjs'
const claims = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(claims, 'profiles/claims-v1.json'), 'utf8'))
const repo = resolve(claims, '..')
const desktop = process.argv.includes('--desktop-chat')
const managed = desktop && process.env.CLAIMS_MANAGED_CHAT === '1'
const worker = !desktop && process.env.DSH_PROFILE === 'claims-worker'
const profile = desktop ? 'claims-desktop-chat' : worker ? 'claims-worker' : 'claims-workbench'
const home = resolve(process.env.DSH_HOME || join(repo, desktop ? '.desktop-chat-home' : '.claims-home'))
const workstationUser = desktop && directory(process.env.CLAIMS_SHOWCASE === '1').employees.find(user =>
  user.profile === 'claims-v1' && user.principalId === (process.env.CLAIMS_DESKTOP_USER || 'maya'))
if (desktop && !workstationUser) throw new Error('CLAIMS_DESKTOP_USER must name an employee in the workbench roster')
const runtimeHome = desktop ? join(home, workstationUser.subject) : home
const dir = join(runtimeHome, 'profiles', profile)
const moduleDir = join(dir, 'node_modules')
async function link(name, target) {
  const path = join(moduleDir, name)
  await mkdir(dirname(path), { recursive: true })
  try {
    await symlink(target, path, 'dir')
  } catch (err) {
    if (err.code !== 'EEXIST' || (await realpath(path)) !== (await realpath(target))) throw err
  }
}
const bundles = worker ? [] : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const chatProvider = inferenceProvider(process.env, desktop)
const personalProviders = chatProvider && !worker && !desktop && process.env.CLAIMS_SHARED_CHAT === '1'
  ? await (await import('../shared-chat/model-profiles.mjs')).personalModelProviders(home,directory(process.env.CLAIMS_SHOWCASE === '1'),chatProvider)
  : {}
const sharedWebRows = [
  { id: 'ui-brand-official', disabled: true },
  { insert: [{ id: 'enterprise-agent-brand', name: '@local/enterprise-agent-brand' }] },
  { id: 'ui-settings-models', config: {
    credentialOnboarding: false,
    welcomeBody: 'Welcome to Enterprise Agent. Ask your agent about work in your workspace or claims in your portfolio. Open Workbench to review assigned records.',
  } },
  ...[
    'session-log-deepseek',
    'session-telemetry-otel',
    'desktop-product-telemetry',
    'product-analytics',
    'harness-dev-context',
    'message-feedback',
    'session-log-download',
    'command-feedback',
  ].map((id) => ({ id, disabled: true })),
  { id: 'web-deepseek-api', config: { sendOriginalQuestion: false } },
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        ...(chatProvider && { 'claims-local': chatProvider }),
        ...personalProviders,
      },
    },
  },
]
const claimsPatch = worker
  ? [{ insert: [{ id: 'claims-worker', name: join(claims, 'runtime/worker.mjs') }] }]
  : [
      {
        id: 'connection',
        config: {
          authentication: 'external',
          trustedHosts: [new URL(process.env.CLAIMS_APP_ORIGIN || 'http://localhost:3080').host],
        },
      },
      { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } },
      ...(process.env.CLAIMS_SHARED_CHAT === '1' ? [{ id: 'agent-default-model', config: { provider: 'claims-local', model: process.env.CLAIMS_MODEL_ID || 'claims-local' } }] : []),
      ...sharedWebRows,
      {
        insert: [
          { id: 'claims-database', name: join(claims, 'runtime/database.mjs') },
          { id: 'claims-auth', name: join(claims, 'auth/index.mjs') },
          { id: 'claims-workbench', name: '@local/claims-workbench' },
          ...(process.env.CLAIMS_SHARED_CHAT === '1' ? [
            { id: 'claims-shared-chat', name: join(claims, 'shared-chat/plugin.mjs') },
            { id: 'employee-chat-client', name: '@local/claims-desktop-chat' },
            { id: 'employee-chat-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'employee-chat', order: 100,
              plugins: [
                { id: 'employee-persona', name: '@deepseek-ai/dsh-persona', config: { complete: true,
                  includeRuntimeContext: false, prefix: 'You are Enterprise Agent. Answer ordinary questions directly. Use the private workspace for file and command requests.' } },
                { id: 'workspace-tools', name: join(claims, 'shared-chat/tools.mjs') },
              ] } },
          ] : []),
          {
            id: 'claims-preset',
            name: '@deepseek-ai/dsh-agent-preset',
            config: {
              id: 'claims-v1',
              order: 0,
              plugins: [
                {
                  id: 'claims-persona',
                  name: '@deepseek-ai/dsh-persona',
                  config: { prefix: manifest.instructions, complete: true, includeRuntimeContext: false },
                },
              ],
            },
          },
        ],
      },
    ]
const patch = desktop ? [
  { id: 'web-runtime', config: { openBrowser: false, printUrl: true } },
  { id: 'agent-default-model', config: { provider: 'claims-local', model: process.env.CLAIMS_MODEL_ID || 'claims-local' } },
  ...sharedWebRows,
  ...(managed ? [{ id: 'workspace-controller', config: { documentsDirectory: join(home, 'Documents') } }] : []),
  { id: 'directory-picker', disabled: true },
  { insert: [
    { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
    { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
  ] },
  { insert: [{ id: 'desktop-workbench-navigation', name: '@local/claims-desktop-chat' }] },
] : claimsPatch
const marker = '# Generated by claims/runtime/launch.mjs\n'
// prepareProfile in apps/cli/src/profile-boot.ts writes this canonical file on boot.
// The launch regression runs that actual CLI so a future format change is visible.
const cliEmptyRoot = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`
const configs = {
  'package.json':
    JSON.stringify(
      { name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles } } },
      null,
      2,
    ) + '\n',
  'cordis.yml': '[]\n',
  'cordis.patch.yml': marker + JSON.stringify(patch, null, 2) + '\n',
}
// Inspect every target before creating even the module links. The two files
// without a generated header must exactly match this profile's fixed template.
const writes = []
for (const [name, content] of Object.entries(configs)) {
  const path = join(dir, name)
  let previous
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Existing unmanaged claims profile at ' + path)
    previous = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  if (previous === content) continue
  if (name === 'cordis.yml' && previous === cliEmptyRoot) continue
  if (previous !== undefined && !(name === 'cordis.patch.yml' && previous.startsWith(marker)))
    throw new Error('Existing unmanaged claims profile at ' + path)
  writes.push({ path, content, create: previous === undefined })
}
await mkdir(dir, { recursive: true })
if (desktop) {
  await link('@local/claims-desktop-chat', join(claims, 'desktop-chat'))
  await link('@deepseek-ai/dsh-host-directory-picker-browse', join(repo, 'packages/host/directory-picker-browse'))
  await link('@deepseek-ai/dsh-client-ui-directory-picker-browse', join(repo, 'packages/client/ui-directory-picker-browse'))
} else {
  await link('@local/claims-workbench', claims)
  if (!worker && process.env.CLAIMS_SHARED_CHAT === '1') await link('@local/claims-desktop-chat', join(claims, 'desktop-chat'))
}
if (!worker) {
  await link('@local/enterprise-agent-brand', join(claims, 'brand'))
  await link('@deepseek-ai/dsh-agent-preset', join(repo, 'packages/preset/agent-preset'))
  await link('@deepseek-ai/dsh-persona', join(repo, 'packages/preset/persona'))
  await link(bundles[0], join(repo, 'packages/bundle/base'))
  await link(bundles[1], join(repo, 'packages/bundle/web-app'))
}
for (const { path, content, create } of writes) {
  if (create) {
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    } catch (err) {
      if (err.code !== 'EEXIST' || (await readFile(path, 'utf8')) !== content) throw err
    }
  } else {
    const staged = path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(staged, content, { flag: 'wx', mode: 0o600 })
      await rename(staged, path)
    } finally {
      await rm(staged, { force: true })
    }
  }
}
const extras = process.argv.slice(2).filter(arg => arg !== '--desktop-chat')
const dump = extras.includes('--dump-config')
if (desktop && extras.some(arg => !['--dump-config', '--no-open'].includes(arg))) {
  throw new Error('Desktop chat manages its own private listener. Supported option: --dump-config')
}
const host = process.env.CLAIMS_BIND_HOST || (process.env.CLAIMS_CONTAINER === '1'
  ? await resolveContainerAddress()
  : '127.0.0.1')
const listener = desktop
  ? ['--host', '127.0.0.1', '--port', '0', '--no-open']
  : ['--host', host, '--port', String(process.env.CLAIMS_PORT || 3080), '--no-open',
     '--public-url', process.env.CLAIMS_APP_ORIGIN || 'http://localhost:3080']
if (!desktop && !host) throw new Error('No concrete claims web interface found')
const args = [join(repo, 'apps/cli/lib/bin.js'), '--profile', profile,
  ...(!worker && !dump ? listener : []), ...extras.filter(arg => !desktop || arg !== '--no-open')]
const privateChat = desktop && !dump
const lazy = managed && privateChat && process.env.CLAIMS_LAZY_CHAT === '1'
const spawnNative = () => spawn(process.execPath, args, {
  cwd: repo,
  env: {
    ...process.env,
    DSH_HOME: runtimeHome,
    DSH_TELEMETRY_DISABLED: '1',
    CLAIMS_LOCAL_MODEL_KEY: process.env.CLAIMS_LOCAL_MODEL_KEY || 'local-only',
  },
  stdio: lazy ? ['ignore', 'pipe', 'inherit', 'ipc'] : privateChat ? ['ignore', 'pipe', 'inherit'] : 'inherit',
})
if (lazy) {
  const { startDesktopGateway, pairPrivateChat } = await import('../desktop-chat/gateway.mjs')
  const { lazyRuntime, startPrivateRuntime } = await import('../desktop-chat/lazy-runtime.mjs')
  const port = MANAGED_CHAT_PORTS[workstationUser.principalId]
  const runtime = lazyRuntime(() => startPrivateRuntime(spawnNative, url => pairPrivateChat(url, port)))
  const server = await startDesktopGateway({ user: workstationUser, managedPort: port, acquireNative: runtime.acquire })
  const stop = async () => {
    server.close()
    server.closeAllConnections()
    await runtime.close()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
} else {
  const child = spawnNative()
  let gateway
  let stopping = false
  function stopGateway() {
    gateway?.close()
    gateway?.closeAllConnections()
  }
  function stop(signal = 'SIGTERM') {
    stopping = true
    stopGateway()
    child.kill(signal)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal))
  child.once('exit', (code, signal) => {
    stopping = true
    stopGateway()
    process.exitCode ||= code ?? (signal === 'SIGTERM' ? 143 : 1)
  })
  if (privateChat) {
    // Consume the private upstream login in memory. Only the workbench sign-in address is announced.
    const lines = createInterface({ input: child.stdout })
    let starting = false
    for await (const line of lines) {
      if (starting || !line.startsWith('dsh web: http://127.0.0.1:')) continue
      starting = true
      try {
        const { startDesktopGateway } = await import('../desktop-chat/gateway.mjs')
        gateway = await startDesktopGateway({
          launchUrl: line.slice('dsh web: '.length),
          user: workstationUser,
          managedPort: managed ? MANAGED_CHAT_PORTS[workstationUser.principalId] : undefined,
        })
        if (stopping) stopGateway()
        else console.info('Open ' + (process.env.CLAIMS_APP_ORIGIN || 'http://localhost:3080') + ' to sign in. Local chat is available for ' + workstationUser.displayName + '.')
      } catch (error) {
        console.error('Chat could not start (' + (error.code || error.name) + '). Check the host and assigned chat port.')
        process.exitCode = 1
        stop()
      }
    }
  }
}
