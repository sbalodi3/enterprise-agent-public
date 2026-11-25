// Deterministic local OpenAI-compatible model for the isolated release gate.
import http from 'node:http'
const answer = 'Fixture reply received.'
http.createServer(async (req,res) => {
  if (req.url.endsWith('/models')) {
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify({data:[{id:'claims-local',object:'model'}]}))
    return
  }
  if (req.method !== 'POST') { res.writeHead(404).end(); return }
  try {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 2_000_000) throw Error('Request too large')
    }
    const {messages,tools} = JSON.parse(body)
    const last = messages.at(-1)
    const department = messages.some(message => message.role === 'system' && JSON.stringify(message.content).includes('read-only department assistant'))
    const proof = last?.role === 'user' && /workspace smoke file ([a-f0-9-]{36})/.exec(JSON.stringify(last.content))?.[1]
    const command = proof && tools?.some(tool => tool.function.name === 'workspace_command')
    const write = (delta,finish_reason = null) => res.write('data: '+JSON.stringify({
      id:'fixture',object:'chat.completion.chunk',model:'claims-local',created:10,choices:[{index:0,delta,finish_reason}]
    })+'\n\n')
    res.setHeader('content-type','text/event-stream')
    if (command) {
      write({role:'assistant',tool_calls:[{index:0,id:'test-'+Date.now(),type:'function',function:{
        name:'workspace_command',arguments:JSON.stringify({command:'echo '+proof+' > proof-'+proof+'.txt && cat proof-'+proof+'.txt'})}}]})
      write({},'tool_calls')
    } else {
      write({role:'assistant',content:last?.role === 'tool' ? 'Workspace tool result received.' : department ? '{"entries":[1]}' : answer})
      write({},'stop')
    }
    res.end('data: [DONE]\n\n')
  } catch { res.destroy() }
}).listen(Number(process.env.PORT || 43813),process.env.HOST || '127.0.0.1')
