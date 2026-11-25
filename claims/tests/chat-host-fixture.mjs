import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const rn = createRequire(
  new URL('../../packages/preset/agent-preset-registry/package.json', import.meta.url),
).resolve
const pkg = (name) => import(pathToFileURL(rn('@deepseek-ai/' + name)).href)
export async function createChatHost(t, profile) {
  const { Context } = await pkg('cordis')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.baseUrl = import.meta.url
  await ctx.plugin((await pkg('cordis-plugin-loader')).default)
  ctx.loader.builtins.group = (await pkg('cordis-plugin-group')).default
  for (const name of [
    'llm',
    'session',
    'session-projection',
    'system-prompt',
    'tools',
    'tool-executor-native',
    'agent',
    'agent-loop',
  ]) {
    const p = await pkg('dsh-' + name)
    await ctx.plugin(p.default || p, name === 'agent-loop' ? { agents: [] } : {})
  }
  await ctx.plugin((await import('../../packages/preset/agent-preset-registry/lib/index.js')).default, {
    default: profile.id,
  })
  await ctx.agentPresets.register({ id: profile.id, plugins: [] })
  return ctx
}

