import { registerPageEntry } from '../runtime/page-entry.mjs'
export const inject = ['webServer', 'agents']
export function apply(ctx) {
  if (process.env.CLAIMS_SHARED_CHAT === '1' && process.env.CLAIMS_MANAGED_CHAT !== '1') {
    ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('<head>', '<head><meta name="claims-shared-host" content="1">')), 'shared chat: surface selection')
    return
  }
  registerPageEntry(ctx, '/open-chat', '/#new-desktop-session')
  if (process.send && process.env.CLAIMS_LAZY_CHAT === '1') {
    // A closed tab can leave a native turn running. Check the live registry before reclaiming it.
    const probe = message => {
      if (typeof message?.idleProbe === 'string' && process.connected)
        process.send({ idleProbe: message.idleProbe, idle: ctx.agents.list().every(agent => agent.status === 'idle') })
    }
    ctx.effect(() => {
      process.on('message', probe)
      return () => process.off('message', probe)
    }, 'claims: managed runtime idle probe')
  }
}
