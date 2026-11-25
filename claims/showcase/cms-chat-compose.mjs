import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CMS_USERS } from '../auth/roster.mjs'
import { managedChatPorts } from '../desktop-chat/modes.mjs'

export const cmsChatServices = CMS_USERS.map(user => 'chat-' + user.principalId)
export function writeCmsChatCompose(cacheDir) {
  const ports = managedChatPorts(3183, true)
  const services = {}, volumes = {}
  for (const [index, { principalId }] of CMS_USERS.entries()) {
    const name = cmsChatServices[index]
    const port = ports[principalId]
    volumes[name] = {}
    // Each gateway owns only this employee's workspace, plus read-only application code.
    services[name] = {
      profiles: ['cms-chat'], image: 'claims-workbench:local', pull_policy: 'never',
      restart: 'unless-stopped', stop_grace_period: '30s', command: ['--desktop-chat'],
      networks: ['chat'], ports: ['127.0.0.1:' + port + ':' + port],
      depends_on: { 'chat-authority': { condition: 'service_started' } },
      volumes: [name + ':/data', ...['runtime','auth','desktop-chat','ui'].map(dir =>
        './claims/' + dir + ':/app/deepseek-harness/claims/' + dir + ':ro,z')],
      environment: { CLAIMS_MANAGED_CHAT: '1', CLAIMS_LAZY_CHAT: '1', CLAIMS_SHOWCASE: '1', CLAIMS_CMS_MCP: '1',
        CLAIMS_CHAT_INTERNAL_ORIGIN: 'http://chat-authority:3080',
        CLAIMS_APP_ORIGIN: 'http://127.0.0.1:3180', CLAIMS_CHAT_PORT_BASE: '3183',
        CLAIMS_DESKTOP_USER: principalId, CLAIMS_DESKTOP_PORT: String(port),
        CLAIMS_MODEL_URL: '${CLAIMS_MODEL_URL:-http://llama:8080/v1}', CLAIMS_MODEL_ID: '${CLAIMS_MODEL_ID:-claims-local}',
        DSH_HOME: '/data/harness', HOME: '/data/harness', DSH_TELEMETRY_DISABLED: '1' },
      healthcheck: { test: ['CMD','node','claims/deploy/chat-healthcheck.mjs'], interval: '60s', start_interval: '3s',
        start_period: '45s', timeout: '5s', retries: 5 },
    }
  }
  const path = join(cacheDir, 'cms-chat-compose.json')
  const staging = path + '.' + randomUUID()
  writeFileSync(staging, JSON.stringify({ services, volumes }, null, 2) + '\n', { mode: 0o600 })
  renameSync(staging, path)
  return path
}
