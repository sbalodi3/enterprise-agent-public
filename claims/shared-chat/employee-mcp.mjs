import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const { parse } = createRequire(new URL('../../packages/boot/config-editor/package.json',import.meta.url))('yaml')
const require = createRequire(new URL('../../packages/mcp/mcp-client/package.json', import.meta.url))
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client')
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio')

export function employeeTools(yaml) {
  const servers = new Map()
  function visit(rows) {
    for (const row of rows) {
      if (row?.id === 'mcp-manager' && !row.disabled) {
        for (const [name,cfg] of Object.entries(row.config?.servers ?? {})) {
          if (cfg.enabled === false) continue
          if (!/^[A-Za-z0-9_-]{1,48}$/.test(name)) throw Error('Review employee MCP server name')
          if (cfg.transport === 'streamable-http') {
            if (!['http://searxng-mcp:8000/mcp','http://search-mcp:8000/mcp'].includes(cfg.url) || Object.keys(cfg.headers ?? {}).length)
              throw Error('Review employee HTTP tool endpoint: ' + name)
            servers.set(name,{transport:cfg.transport,url:cfg.url})
          } else if (cfg.transport === 'stdio') {
            if (!cfg.command || !Array.isArray(cfg.args ?? []) || cfg.cwd && !['/workspace','/data/harness/Documents'].includes(cfg.cwd) ||
                Object.keys(cfg.env ?? {}).length) throw Error('Review executable tool configuration: ' + name)
            servers.set(name,{transport:'stdio',argv:[cfg.command,...(cfg.args ?? [])]})
          } else throw Error('Review employee MCP transport: ' + name)
        }
      }
      if (Array.isArray(row?.insert)) visit(row.insert)
      if (Array.isArray(row?.group)) visit(row.group)
    }
  }
  const rows = parse(yaml)
  if (!Array.isArray(rows)) throw Error('Unrecognized native profile patch')
  visit(rows)
  return servers
}

/** Discover and invoke the employee's configured server only when requested by a turn. */
export function employeeMcpTool(name,config,subject) {
  return { name:'employee_'+name,
    description:'Use your '+name+' connection. Omit method to discover its tools and input schemas.',
    parameters:{type:'object',properties:{method:{type:'string'},arguments:{type:'object',additionalProperties:true}},additionalProperties:false},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute(input,exec) {
      const client = new Client({name:'enterprise-agent',version:'1'})
      const transport = config.transport === 'stdio' ? new StdioClientTransport({
        command:process.execPath,args:[fileURLToPath(new URL('./stdio-client.mjs',import.meta.url))],
        env:{CLAIMS_TOOL_SUBJECT:subject,CLAIMS_TOOL_ARGV:JSON.stringify(config.argv),
          CLAIMS_WORKSPACE_MANAGER_SOCKET:process.env.CLAIMS_WORKSPACE_MANAGER_SOCKET || '/run/chat-manager/workspace.sock'},
      }) : new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{redirect:'error'}})
      const signal = AbortSignal.any([exec.signal,AbortSignal.timeout(60000)])
      try {
        await client.connect(transport,{signal})
        const result = input.method ? await client.callTool({name:input.method,arguments:input.arguments??{}},undefined,{signal}) :
          await client.listTools(undefined,{signal})
        return JSON.stringify(result).slice(0,50000)
      } finally { await client.close() }
    },
  }
}
