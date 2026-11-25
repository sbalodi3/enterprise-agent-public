import { requireEmployeeChatSession } from '../portfolios/chat.mjs'
import { startConfiguredWidgetSandbox } from './widget-sandbox.mjs'
import { widgetResources } from './widget-resources.mjs'
import { registerPdfViewer } from './pdf-viewer.mjs'
import { registerPageEntry } from './page-entry.mjs'
import { readFile } from 'node:fs/promises'
import { createDomain } from '../domain/index.mjs'
import { createApi } from './api.mjs'
import { createConversationApi } from './conversation-api.mjs'
import { installAssistant } from './assistant.mjs'
import { validateProfile } from './profile.mjs'
import { createFixtureIngress } from '../integrations/fixtures.mjs'
import { createConnections } from '../connections/http.mjs'
import { createMailChat } from '../connections/mail-chat.mjs'
import { telemetry } from './telemetry.mjs'

export const name = 'claims-workbench'
export const inject = ['claimsDatabase', 'claimsAuth', 'webServer', 'agents', 'agentPresets', 'llm', 'tools']

// A default-profile HTTP request can disappear after approval commits and
// before the inline simulator dispatch runs. The outbox survives that gap.
export function startLocalDispatchRecovery(domain, trace, intervalMs = 3000) {
  let active
  async function recover() {
    const { items } = await domain.dispatchable()
    for (const { operationId } of items) {
      try {
        const input = { operationId }
        const approval = await domain.operationSpan(input)
        await trace.run('simulator.recover', () => domain.dispatchOperation(input), approval)
      } catch (error) {
        console.error('Claims simulator dispatch will retry', error.name)
      }
    }
  }
  function tick() {
    if (!active) {
      active = recover()
        .catch((error) => console.error('Claims outbox read will retry', error.name))
        .finally(() => {
          active = null
        })
    }
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await active
  }
}

export async function apply(ctx) {
  registerPageEntry(ctx, '/open-app', '/')
  registerPageEntry(ctx, '/open-companion', '/?mode=companion')
  registerPageEntry(ctx, '/open-workbench', '/?mode=workbench#workbench')
  const profile = validateProfile(
    JSON.parse(await readFile(new URL('../profiles/claims-v1.json', import.meta.url), 'utf8')),
  )
  const pool = ctx.claimsDatabase
  const connected = process.env.CLAIMS_SHOWCASE === '1'
  const juris =
    connected &&
    (await import('../domain/juris-client.mjs')).createJurisClient({
      url: process.env.JURIS_URL,
      token: process.env.JURIS_SERVICE_TOKEN,
    })
  const domain = createDomain(pool, connected ? { showcase: { juris, partner: (await import('../showcase/connections.mjs')).wageDestination() } } : {})
  const showcase = connected && (await import('../showcase/connections.mjs')).connectShowcase(domain)
  const otlp = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const trace = telemetry(otlp ? new URL('/v1/traces', otlp).href : undefined)
  ctx.effect(() => () => trace.close(), 'claims: traces')
  let connection
  const story = process.env.CLAIMS_TEMPORAL_ENABLED === 'true'
  if (!story) ctx.effect(() => startLocalDispatchRecovery(domain, trace), 'claims: local outbox recovery')
  const workflow = story
    ? () => {
        connection ??= import('../worker/client.mjs')
          .then(({ submitClient }) =>
            submitClient({
              address: process.env.TEMPORAL_ADDRESS || 'temporal:7233',
              namespace: process.env.TEMPORAL_NAMESPACE || 'default',
              taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'claims-work',
            }),
          )
          .catch((error) => {
            connection = undefined
            throw error
          })
        return connection
      }
    : undefined
  ctx.effect(
    () => async () => {
      if (connection) await (await connection).close()
    },
    'claims: workflow client',
  )
  const workerToken =
    process.env.CLAIMS_WORKER_TOKEN ||
    process.env.WORKER_API_TOKEN ||
    (process.env.WORKER_API_TOKEN_FILE
      ? (await readFile(process.env.WORKER_API_TOKEN_FILE, 'utf8')).trim()
      : '')
  if (story && !workerToken) throw new Error('Claims story profile requires a worker credential')
  const shutdown = new AbortController()
  ctx.effect(() => () => shutdown.abort(), 'claims: stop conversation turns')
  let departmentApi
  if (connected) {
    const { createPortfolioStore } = await import('../portfolios/store.mjs')
    const { createDepartmentApi } = await import('../portfolios/api.mjs')
    const { createDepartmentAssistant } = await import('../portfolios/assistant.mjs')
    const { startPortfolioHandoffs } = await import('../portfolios/a2a-client.mjs')
    const store = createPortfolioStore(pool)
    const handoffs = startPortfolioHandoffs({ store })
    ctx.effect(() => () => handoffs.stop(), 'portfolios: stop mock agent handoffs')
    const assistant = createDepartmentAssistant({ store, pool, llm: ctx.llm, signal: shutdown.signal })
    const { createDepartmentChat } = await import('../portfolios/chat.mjs')
    departmentApi = createDepartmentApi({
      store, handoffs, assistant, chat: createDepartmentChat(pool, store, assistant),
    })
  }
  const { installClaimChat } = await import('./claim-chat.mjs')
  const runTurn = installClaimChat(ctx, { domain, profile, trace })
  const ingress = createFixtureIngress({ domain, token: process.env.CLAIMS_FIXTURE_TOKEN, workerToken })
  if (!connected)
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/claims/integrations/fixtures',
          handler: (req, res) => trace.run('fixture.delivery', () => ingress(req, res)),
        }),
      'claims: simulated source ingress',
    )
  const connections = createConnections({ pool, auth: ctx.claimsAuth })
  const mailChat = createMailChat({ ctx, pool, connections, profile })
  const handler = createApi({
    connections, mailChat, shutdown: shutdown.signal,
    requireMailSession: process.env.CLAIMS_SHARED_CHAT === '1' ? (user, id) => requireEmployeeChatSession(pool, user, id) : undefined,
    domain,
    auth: ctx.claimsAuth,
    departmentApi,
    showcase,
    assist: installAssistant(ctx, domain, profile, trace),
    conversationApi: createConversationApi({
      domain, auth: ctx.claimsAuth, runTurn, trace, shutdown: shutdown.signal,
      outlookConnected: async principal => (await connections.status(principal, 'outlook-mail')).status === 'connected',
      async runOutlook({ principal, conversationId, turnId, question, timeZone, signal, reauthorize }) {
        await mailChat({ principal, method: 'POST', path: 'claims-' + conversationId, signal, reauthorize,
          input: { requestId: turnId, question, selected: true, timeZone: timeZone || 'UTC' } })
        return { text: 'Outlook Mail', outlookRef: turnId, sources: [] }
      },
    }),
    profile,
    workflow,
    workerToken,
    trace,
    ready: () => pool.query('SELECT 1'),
  })
  for (const path of [
    '/health/ready',
    '/claims/api',
    '/claims/connections/microsoft/callback',
    '/api/internal/work',
    ...(connected ? ['/claims/integrations/showcase'] : []),
  ]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler }), 'claims: ' + path)
  }
  const assets = new Map()
  const sandbox = await startConfiguredWidgetSandbox(process.env)
  if (sandbox) {
    const { server } = sandbox
    ctx.effect(() => () => { server.close(); server.closeAllConnections() }, 'claims: stop widget sandbox')
  }
  assets.set('/claims/assets/widget-settings.json', { type: 'application/json', body: JSON.stringify({ origin: sandbox?.origin ?? null }) })
  for (const [name, resource] of widgetResources)
    assets.set('/claims/assets/' + name + '.widget.json', { type: 'application/json', body: JSON.stringify(resource) })
  if (process.env.CLAIMS_WAGE_REVIEW === '1') {
    assets.set('/claims/assets/wage-review.bundle.mjs', { type: 'text/javascript',
      body: await readFile(new URL('../build/wage-review.bundle.mjs', import.meta.url)) })
  }
  await registerPdfViewer(ctx, assets)
  for (const [file, type] of [
    ['app-connections.mjs', 'text/javascript'],
    ['app-connections.css', 'text/css'],
    ['app-connections-mail.svg', 'image/svg+xml'],
    ['workspace-files.mjs','text/javascript'],
    ['outlook-chat.mjs', 'text/javascript'],
    ['workbench-panel.mjs', 'text/javascript'],
    ['workbench.mjs', 'text/javascript'],
    ['workbench.css', 'text/css'],
    ['timeline-host.mjs', 'text/javascript'],
    ['widget-format.mjs', 'text/javascript'],
    ['action-review.mjs','text/javascript'],
    ['showcase.mjs', 'text/javascript'],
    ['pdf-link.mjs', 'text/javascript'],
    ['claim-pdf.mjs', 'text/javascript'],
    ['claim-pdf.css', 'text/css'],
    ['native-claims.mjs', 'text/javascript'],
    ['claim-scope.mjs', 'text/javascript'],
    ['native-claims.css', 'text/css'],
    ['claim-chat.mjs', 'text/javascript'],
    ['claim-chat.css', 'text/css'],
    ...(connected ? [['department-chat.mjs', 'text/javascript'], ['portfolios.mjs', 'text/javascript'], ['portfolios.css', 'text/css']] : []),
  ]) {
    assets.set('/claims/assets/' + file, {
      type,
      body: await readFile(new URL('../ui/' + file, import.meta.url)),
    })
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/claims/assets',
        handler(req, res) {
          const asset = assets.get(new URL(req.url, 'http://localhost').pathname)
          if (!asset || req.method !== 'GET') {
            res.writeHead(404)
            res.end()
            return
          }
          res.writeHead(200, {
            'content-type': asset.type + '; charset=utf-8',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
          })
          res.end(asset.body)
        },
      }),
    'claims: panel assets',
  )
}
