import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, renameSync, readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { containerEnvironment } from './container-engine.mjs'

export const workspaceImage = 'localhost/claims-workspace:v1'
export function activationMarker(cache,engine) {
  return join(cache, engine === 'docker' ? 'shared-chat.active.json' : 'shared-chat.'+engine+'.active.json')
}
export function activeSharedChat(cache,engine) {
  const marker = activationMarker(cache,engine)
  return existsSync(marker) ? JSON.parse(readFileSync(marker)) : undefined
}
export function useSharedChat({ cache, project, engine, requested }) {
  if (activeSharedChat(cache,engine) || process.env.CLAIMS_SHARED_CHAT_VOLUME) return true
  const volumes = execFileSync(engine, ['volume','ls','--filter','label=com.docker.compose.project='+project,'--format','{{.Name}}'],
    {encoding:'utf8',env:containerEnvironment(engine)}).trim().split('\n')
  const legacy = volumes.some(name => name.startsWith(project+'_claims-chat-') || name.startsWith(project+'_chat-cms-') || name === project+'_chat-claims-admin')
  if (requested && legacy) throw Error('Stage the existing employee volumes and set CLAIMS_SHARED_CHAT_VOLUME before switching this deployment.')
  return !legacy
}
export function sharedOverlay({ project, cache, showcase, cms, engine, socket, bookmarks = true, searchNetwork = process.env.CLAIMS_SEARCH_NETWORK }) {
  const name = join(cache, 'shared-chat.compose.json')
  const active = activeSharedChat(cache,engine)
  if (active && active.project !== project) throw Error('Staged Chat deployment mismatch')
  const image = process.env.CLAIMS_SHARED_CHAT_IMAGE || active?.image || 'claims-workbench:local'
  const shared = process.env.CLAIMS_SHARED_CHAT_VOLUME || active?.shared
  searchNetwork ||= active?.searchNetwork
  const first = showcase ? 3183 : 3083
  // Only previously published bookmarks get listeners. Adding roster entries never expands this set.
  const ports = [first,first+1,first+2]
  if (cms) for (let offset=18; offset<=38; offset++) ports.push(first+offset)
  const location = socket ?? (engine === 'podman' ? execFileSync('podman',
    ['info','--format','{{.Host.RemoteSocket.Path}}'], { encoding: 'utf8' }).trim() : '/var/run/docker.sock')
  const engineSocket = location.replace(/^unix:\/\//,'')
  if (!engineSocket.startsWith('/') || engineSocket.includes(':')) throw Error('Invalid engine socket')
  const config = { services: {
    workbench: { image, environment: { CLAIMS_SHARED_CHAT: '1' }, volumes: ['shared-chat-harness:/data','chat-manager-socket:/run/chat-manager:ro'],
      ...(searchNetwork && { networks: ['claims','employee-search'] }),
      depends_on: { 'workspace-manager': { condition: 'service_started' } } },
    'workspace-manager': {
      image: 'localhost/claims-workspace-manager:v1', build: { context: './claims/shared-chat', dockerfile: 'Dockerfile.manager' },
      network_mode: 'none', read_only: true, ...(engine==='podman' && {security_opt:['label=disable']}), restart: 'unless-stopped',
      environment: { CLAIMS_DEPLOYMENT: project, CLAIMS_WORKSPACE_IMAGE: workspaceImage },
      volumes: [engineSocket + ':/run/engine.sock', 'chat-manager-socket:/run/chat-manager', 'chat-manager-state:/var/lib/chat-manager'],
    },
    'chat-bookmarks': { image, pull_policy: 'never', read_only: true, restart: 'unless-stopped',
      entrypoint: ['node','claims/shared-chat/redirect.mjs'],
      environment: { CLAIMS_APP_ORIGIN: showcase ? 'http://127.0.0.1:3180' : '${CLAIMS_APP_ORIGIN:-http://localhost:3080}' },
      ports: ports.map(port => '127.0.0.1:' + port + ':8080'), networks: ['claims'] },
  }, volumes: { 'chat-manager-state': {}, 'chat-manager-socket': {}, 'shared-chat-harness': shared ? {external:true,name:shared} : {} },
    ...(searchNetwork && { networks: { 'employee-search': { external:true,name:searchNetwork } } }) }
  if (!bookmarks) delete config.services['chat-bookmarks']
  mkdirSync(cache, { mode: 0o700, recursive: true })
  const staging = name + '.' + randomUUID()
  writeFileSync(staging, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
  renameSync(staging, name)
  return name
}
export function buildWorkspace(engine, options) {
  execFileSync(engine, ['build','-t',workspaceImage,'-f','claims/shared-chat/Dockerfile.workspace','claims/shared-chat'], options)
}
