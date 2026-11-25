export const dailyActions = ['add_note', 'update_field', 'create_diary', 'reschedule_diary', 'complete_diary']
export const fieldNames = ['handlingPriority', 'nextHandlingInstruction']
const priorities = ['Routine', 'High', 'Urgent']
const plain = (v, max = 2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0')
const date = v => plain(v, 32) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
const keys = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v,k))

/** The same command validation runs at proposal creation and in the destination transaction. */
export function validHandlingCommand(action, p) {
  switch (action) {
    case 'add_note': return keys(p,['category','text','source']) && ['General','Contact','Supplemental'].includes(p.category) &&
      plain(p.text) && plain(p.source,180)
    case 'update_field': return keys(p,['field','value','reason']) && fieldNames.includes(p.field) &&
      (p.field === 'handlingPriority' ? priorities.includes(p.value) : plain(p.value,500)) && plain(p.reason,500)
    case 'create_diary': return keys(p,['purpose','owner','dueAt']) && plain(p.purpose,500) && plain(p.owner,100) && date(p.dueAt)
    case 'reschedule_diary': return keys(p,['diaryId','dueAt']) && plain(p.diaryId,100) && date(p.dueAt)
    case 'complete_diary': return keys(p,['diaryId','completion']) && plain(p.diaryId,100) && plain(p.completion,500)
    default: return false
  }
}
export function permitsAction(item, action, category) {
  if ((item.lifecycle === 'closed' || ['Paid','Denied','Closed'].includes(item.source_claim_status)) && item.type === 'claim')
    return action === 'add_note' && (!category || category === 'Supplemental')
  return action !== 'add_note' || category !== 'Supplemental'
}

/** Apply an already validated command to the locked destination record. */
export function applyHandling(action, value, state, receipt) {
  const next = { notes: [], diaries: [], handlingPriority: 'Routine', nextHandlingInstruction: '', ...state }
  if (action === 'add_note') next.notes = [...next.notes, { ...value, id: receipt.operationId, at: receipt.appliedAt }]
  else if (action === 'update_field') next[value.field] = value.value
  else if (action === 'create_diary') next.diaries = [...next.diaries, { ...value, id: receipt.operationId, status: 'Open' }]
  else {
    const entry = next.diaries.find(d => d.id === value.diaryId && d.status === 'Open')
    if (!entry) return null
    next.diaries = next.diaries.map(d => d !== entry ? d : action === 'complete_diary'
      ? { ...d, status:'Completed', completion:value.completion, completedAt:receipt.appliedAt }
      : { ...d, dueAt:value.dueAt })
  }
  return next
}
