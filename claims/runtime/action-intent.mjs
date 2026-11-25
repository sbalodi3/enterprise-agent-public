const patterns=[
  ['status',/\b(?:action status|request status|status of (?:the |my )?(?:request|review)|receipt|pending actions?|already (?:request|send|sent)|did we (?:request|send|save|file))\b/i],
  ['complete_diary',/\b(?:close|complete|finish|mark)\b.{0,40}\b(?:diary|callback|follow.up)\b/i],
  ['reschedule_diary',/\b(?:reschedule|move|postpone)\b.{0,40}\b(?:diary|callback|follow.up)\b/i],
  ['create_diary',/\b(?:create|schedule|set|add|remind|prepare)\b.{0,40}\b(?:diary|callback|follow.up|reminder)\b/i],
  ['add_note',/\b(?:add|create|draft|write|record|prepare|save|file)\b.{0,32}\b(?:note|notes)\b/i],
  ['request_wages',/\b(?:request|ask for|order|obtain|send for)\b.{0,32}\b(?:wages?|payroll)\b/i],
  ['update_field',/\b(?:set|change|update|edit|raise|lower)\b.{0,35}\b(?:field|priority|handling instruction)\b/i],
  ['record',/\b(?:show|list|read|what|which|check)\b.{0,60}\b(?:claim notes?|filed notes?|diaries|open diary|handling priority|handling instruction|juris record)\b/i],
  ['list',/\b(?:available actions|what can (?:you|I) do|what actions)\b/i],
]
export function actionIntent(text) {
  if (/\b(?:don't|do not|never|hypothetical)\b/i.test(text))return null
  return patterns.find(([,pattern])=>pattern.test(text))?.[0] ?? null
}
export function followups(text,available) {
  const selected=actionIntent(text)
  const open=available.wages.some(w=>['awaiting-partner','approved','unknown','send-queued'].includes(w.state)) ||
    available.reviews.some(p=>p.action==='request_wages' && p.status==='pending')
  const returned=available.reviews.some(p=>p.action==='record_wage_evidence' && p.status==='pending')
  const candidates=[...(returned?['review_wages']:[]),selected, ...(/payroll|wage/i.test(text)?[open || returned?'status':'request_wages']:[]),
    ...(/due|follow.up|callback/i.test(text)?['create_diary']:[]),'add_note','create_diary','update_field']
  return [...new Set(candidates.filter(a=>['status','review_wages'].includes(a)||available.actions.includes(a)))].slice(0,3)
}

/** Exact user-supplied text and enumerated priorities can be drafted without inference. */
export function explicitActionFields(action, question, finalized) {
  if(action==='request_wages') return {}
  const quoted=question.match(/["“]([^"”]+)["”]/)?.[1]
  if(action==='add_note') {
    const text=quoted || question.match(/\bnote\s*:\s*(.+)$/is)?.[1]
    if(text)return {text,category:finalized?'Supplemental':/contact note/i.test(question)?'Contact':'General'}
  }
  if(action==='update_field') {
    const priority=question.match(/\b(routine|high|urgent)\b/i)?.[1]
    if(priority)return {field:'handlingPriority',value:priority[0].toUpperCase()+priority.slice(1).toLowerCase(),reason:'Requested by adjuster'}
    if(quoted && /handling instruction/i.test(question))return {field:'nextHandlingInstruction',value:quoted,reason:'Requested by adjuster'}
  }
  return null
}
