// Run inside the workbench container so the optional model stays off host ports.
const base = (process.env.CLAIMS_MODEL_URL || 'http://llama:8080/v1').replace(/\/$/, '')
const model = process.env.CLAIMS_MODEL_ID || 'claims-local'
const complete = async input => {
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 256, temperature: 0, chat_template_kwargs: { enable_thinking: false }, ...input }),
    signal: AbortSignal.timeout(90000),
  })
  if (!response.ok) throw new Error(`Local model smoke failed: HTTP ${response.status}`)
  const result = await response.json()
  return result.choices?.[0]?.message
}
const messages = [
  { role: 'system', content: 'Use the lookup_claim tool to retrieve the requested claim. Never invent its status. /no_think' },
  { role: 'user', content: 'Look up claim WC-102 using the provided tool. /no_think' },
]
const tools = [{ type: 'function', function: { name: 'lookup_claim', description: 'Read a synthetic claim by its identifier', parameters: { type: 'object', properties: { claimId: { type: 'string' } }, required: ['claimId'], additionalProperties: false } } }]
const assistant = await complete({ messages, tools, tool_choice: 'auto' })
const call = assistant?.tool_calls?.[0]
if (call?.function?.name !== 'lookup_claim' || JSON.parse(call.function.arguments).claimId !== 'WC-102') throw new Error('Local model did not produce the expected structured tool call')
// This is a test result, not a real domain call or a permission grant.
const final = await complete({ messages: [...messages, assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ claimId: 'WC-102', status: 'awaiting human review', synthetic: true }) }] })
if (typeof final?.content !== 'string' || !final.content.trim()) throw new Error('Local model returned no answer after the tool result')
console.log('Local model produced a structured lookup_claim call and answered after a synthetic tool result. Claims accuracy and harness authorization require separate checks.')
