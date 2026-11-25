export const caseViews = Object.freeze({
  open: { assignedOnly: true },
  due: { assignedOnly: true, dueToday: true },
  waiting: { assignedOnly: true, waitingOnly: true },
})

export function caseRows({ items, total, asOf, filters }, view, explorable = false) {
  return {
    view, total, asOf, ...(explorable && { explorable: true }), ...(view === 'search' && { filters }),
    items: items.map(({ id, title, nextAction, dueAt, section, lob, sourceStatus, ownerId, reason }) => ({
      id, title, nextAction, dueAt, section, ...(lob && { lob, sourceStatus, ownerId, ...(reason && { reason }) }),
    })),
  }
}
