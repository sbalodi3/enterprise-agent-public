// Shared presentation of authorized claim data in embedded apps and host text views.
export const businessLines = {
  '': 'All business lines', PC: 'Property & casualty', AUTO: 'Personal auto',
  COMM_AUTO: 'Commercial auto', HOME: 'Homeowners', WC: 'Workers’ compensation', HEALTH: 'Health',
}

const amount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function summaryMetrics(billings, litigated) {
  const metrics = []
  if (billings != null && billings !== '') metrics.push(['Billings', amount.format(billings)])
  if (litigated != null) metrics.push(['Litigated claims', String(litigated)])
  return metrics
}

export function groupName(group, groupBy) {
  return (groupBy === 'lob' && businessLines[group.key]) || group.label || group.key
}

export function claimTitle(item) {
  // Imported titles can already include the claim number as a separate field.
  return (item.title || '').split(' · ').filter(part => part && part !== item.id).join(' · ')
}

export function casePresentation(item, search) {
  const title = claimTitle(item)
  const line = businessLines[item.lob] || item.lob
  const headline = search && item.lob ? item.reason || title || item.nextAction : item.nextAction || title
  const sameLine = text => line && text?.replaceAll('’', '').toLowerCase() === line.replaceAll('’', '').toLowerCase()
  const facts = [item.id]
  if (title && title !== headline && !sameLine(title)) facts.push(title)
  if (line && !sameLine(headline)) facts.push(line)
  if (item.sourceStatus) facts.push(item.sourceStatus)
  if (search && item.lob && !item.reason && item.nextAction && item.nextAction !== headline) facts.push(item.nextAction)
  return { headline: headline || item.id, context: facts.join(' · ') }
}
