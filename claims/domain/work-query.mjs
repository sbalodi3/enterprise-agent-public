// Present stable source identifiers so history can be rechecked after transfers and read-state changes.
export function presentWorkQuery(operation, ranked, messages, employee, linked = new Map()) {
  const line = m => ({ id: m.id, itemId: m.itemId, label: m.summary, source: m.source, at: m.at })
  let sections, total, text
  if (operation === 'inbox' || operation === 'unread') {
    const items = messages.filter(m => operation === 'inbox' || m.status === 'unread')
      .map(m => ({ ...line(m), status: m.status }))
    sections = [{ label: 'Workbench Inbox', items }]
    total = items.length
    text = operation === 'unread' ? `${total} unread Workbench notification${total === 1 ? '' : 's'}.` :
      `${total} Workbench inbox message${total === 1 ? '' : 's'}.`
  } else {
    const combined = new Set()
    const ready = ranked.filter(item => item.section !== 'waiting').map(item => {
      const message = linked.get(item.id)
      if (message) combined.add(message)
      return { id: item.id, itemId: item.id, label: item.nextAction, title: item.title, source: item.source,
        section: item.section, dueAt: item.dueAt, ...(message && { mailId: message }) }
    })
    const direct = messages.filter(m => m.recipientId === employee && !['answered','resolved'].includes(m.status))
    const obligations = direct.filter(m => (m.kind === 'question' || m.obligationEvent) && !combined.has(m.id)).map(line)
    const requests = direct.filter(m => m.kind === 'request' && !m.obligationEvent).map(line)
    sections = [{ label: 'Assigned work', items: ready }, { label: 'Inbox questions and obligations', items: obligations }]
    if (requests.length) sections.push({ label: 'Requests with no recorded completion', items: requests })
    total = ready.length + obligations.length
    text = `${total} confirmed open action item${total === 1 ? '' : 's'}.`
  }
  return { work: { operation, total, sections }, text, sources: [] }
}
