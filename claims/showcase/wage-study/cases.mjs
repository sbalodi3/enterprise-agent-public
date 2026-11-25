// Matched, synthetic records for the paired study. Reviewers sign off the expected answers separately.
export const studyCases = Array.from({length: 8}, (_, i) => {
  const id = 'WC-' + (951 + i), pair = Math.floor(i / 2), month = i % 2 ? '2026-04-' : '2026-03-'
  const asOf = month + '24T12:00:00Z'
  const doc = (suffix, title, kind, anchors) => ({
    id: id + '-' + suffix, itemId:id, version:1, source: 'Synthetic payroll desk', asOf, title, kind,
    anchors: anchors.map(([id,label,text]) => ({ id,label,text })),
  })
  const request = doc('request', 'Payroll request', 'Wage evidence request', [
    ['coverage','Requested interval','Requested ' + month + '01 through ' + month + '21. Return all payroll records for this interval.'],
  ])
  const records = [request]
  const periods = pair === 0 ? [] : pair === 1 ? [['01','07','600']] : pair === 2 ?
    [['01','14','1200'],['08','21','1200']] : [['01','21','1800'],['01','21','2100']]
  periods.forEach(([first,last,amount], j) => {
    records.push(doc('return-' + j, 'Payroll return ' + (j+1), 'Wage statement', [
      ['period-1', 'Pay period', month + first + ' through ' + month + last +
        '. Gross earnings USD ' + amount + '. Regular hours: unavailable. Overtime hours: unavailable.'],
    ]))
  })
  return { id, records, ownerId:'maya', title:'Payroll review ' + id, state:'ready', reason:'Verify payroll evidence',
    nextAction:'Review the requested interval', source:'Wage evidence study', asOf, dueAt:null,
    claimant:'Study participant ' + (i+1), employer:'Example employer', site:'Study file',
    jurisdiction:'OH', incidentDate:month+'22', documents:records.map(d=>d.id) }
})
