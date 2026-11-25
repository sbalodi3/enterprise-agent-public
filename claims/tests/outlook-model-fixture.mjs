import { LlmAdapter } from '../../packages/llm/llm/lib/index.js'

export class MailToolModel extends LlmAdapter {
  seen = []
  constructor(searchArgs = {query:'WC-103'}) {
    super()
    this.searchArgs = searchArgs
  }
  async *stream({messages,tools=[]}) {
    this.seen.push(tools.map(t => t.name))
    if (!tools.length || messages.some(m => m.role === 'tool')) {
      const text = tools.length ? 'Done' : 'Employer confirmed a callback on Monday.'
      yield { type:'block-start',index:0,blockType:'text' }
      yield { type:'text-delta',index:0,text }
      yield { type:'block-end',index:0,block:{type:'text',text} }
      yield { type:'finish',reason:{kind:'stop'} }
      return
    }
    const prompt = JSON.parse(messages.find(m => m.role === 'user').content[0].text)
    const name = 'mcp__outlook__' + (prompt.selectedRef ? 'read_outlook_message' : 'search_outlook')
    const args = JSON.stringify(prompt.selectedRef ? {ref:prompt.selectedRef} : this.searchArgs)
    yield { type:'block-start', index:0,blockType:'tool-call' }
    yield { type:'tool-call-delta', index:0,id:'mail-test',name,argumentsDelta:args }
    yield { type:'block-end', index:0,block:{type:'tool-call',id:'mail-test',name,arguments:args} }
    yield { type:'finish',reason:{kind:'tool-calls'} }
  }
}
