import { request } from 'node:http'
import { employeeMcpTool } from './employee-mcp.mjs'
import { localSelection } from './model-profiles.mjs'
import { createHash } from 'node:crypto'

/** Runs inside the employee preset. All local I/O is delegated to the private manager socket. */
export const inject = ['tools', 'systemPrompt', 'nativeChatOwnership', 'agentDefaultModel', 'llm']
export function apply(ctx) {
  ctx.systemPrompt.context({ name: 'working-directory:current', order: 0, required: false, text: '' })
  ctx.tools.restrict({ allow: [] })
  ctx.on('agent/created', ({agent}) => {
    const owner = ctx.nativeChatOwnership.owner('session',agent.id)
    if (!owner) throw Error('No verified employee for shared Chat agent')
    if (ctx.nativeChatOwnership.profile('session', agent.id) !== 'claims') return
    installTools(agent.ctx, ctx.nativeChatOwnership, owner)
    const saved = agent.model.current()
    const fallback = localSelection(ctx,owner)
    if (!saved || saved.provider !== fallback.provider || saved.model !== fallback.model) {
      // Append the native selection event. The historical model and request events stay intact.
      agent.model.select(fallback)
    }
  })
}
function installTools(ctx, ownership, owner) {
  const tool = 'workspace_command'
  const allowed = new Set([tool])
  const executable = new Set([tool])
  for (const [name,config] of ownership.toolsFor(owner)) {
    const server = employeeMcpTool(name,config,owner)
    allowed.add(server.name)
    if (config.transport === 'stdio') executable.add(server.name)
    ctx.tools.register(server)
  }
  ctx.tools.guard(call => allowed.has(call.name) ? undefined : 'Only private workspace tools are available.')
  ctx.on('tools/pre-execute', async (exec, next) => {
    const prior = await next()
    return executable.has(exec.name) && prior.kind === 'allow'
      ? { kind: 'ask', reason: 'Run this tool in your private workspace' } : prior
  })
  ctx.on('approval/request', async (event, next) => {
    if (!owner || !executable.has(event.toolName)) return next()
    // A pending decision holds an already-running workspace. A first approval starts no container.
    let hold, retry, finished = false
    function connect() {
      if (finished || event.signal?.aborted) return
      hold = request({ socketPath: process.env.CLAIMS_WORKSPACE_MANAGER_SOCKET || '/run/chat-manager/workspace.sock',
        method: 'POST', path: '/approval', signal: event.signal }, response => response.resume())
      hold.on('error', () => {})
      hold.once('close', () => {
        // Reacquire after a manager restart or when another tab starts the first sandbox.
        if (!finished && !event.signal?.aborted) retry = setTimeout(connect,15000).unref()
      })
      hold.end(JSON.stringify({ subject: owner }))
    }
    connect()
    try { return await next() } finally {
      finished = true
      clearTimeout(retry)
      hold?.destroy()
    }
  }, { prepend: true })
  ctx.tools.register({
    name: tool, description: 'Run a shell command in your private persistent workspace. Read or edit your files here.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ command }, exec) {
      const id = exec.agent?.id
      const subject = id && ownership.owner('session', id)
      if (!subject || !exec.callId) throw Error('No verified workspace owner for this tool call')
      const operation = createHash('sha256').update(JSON.stringify([id,exec.callId])).digest('hex')
      const data = Buffer.from(JSON.stringify({ subject, operation, command }))
      const result = await new Promise((resolve, reject) => {
        const req = request({ socketPath: process.env.CLAIMS_WORKSPACE_MANAGER_SOCKET || '/run/chat-manager/workspace.sock', path: '/run', method: 'POST',
          signal: exec.signal, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('error', reject)
          res.on('data', part => { body += part })
          res.on('end', () => {
            try {
              const value = JSON.parse(body)
              if (res.statusCode !== 200) throw Error(value.error || 'Workspace unavailable')
              resolve(value)
            } catch (error) { reject(error) }
          })
        })
        req.on('error', reject)
        req.end(data)
      })
      return 'Exit ' + result.exitCode + '\n' + result.output
    },
  })
}
