import { wageCoverage } from '../../domain/wage-coverage.mjs'
import { readFileSync } from 'node:fs'
import { claims, intakes, STORY_AS_OF, wagePeriod } from './scenario.mjs'
export { renderDocumentPdf } from './pdf.mjs'

const anchor = (id, label, text) => ({ id, label, text })
const documents = new Map()
function register(id, itemId, title, kind, source, anchors, asOf = STORY_AS_OF) {
  documents.set(id, { id, itemId, title, kind, source, asOf, version: 1, anchors })
}

const reports = {
  'WC-101': [
    'Callback diary',
    'Diary entry',
    'The examiner promised to call Blair at 15:00 UTC on November 17. The employer contact will also be available.',
    'Confirm the callback window in the diary before contacting the employer.',
  ],
  'WC-102': [
    'Employer incident report',
    'Employer report',
    'The employer recorded the incident at Elm Depot on November 13. The supervisor verified the location and the shift.',
    'No payroll statement accompanied the report. Request the preceding 52 weeks of wage evidence from the partner.',
  ],
  'WC-103': [
    'Supervisor incident report',
    'Employer report',
    'The signed supervisor statement records November 9 as the incident date.',
    'Compare the supervisor account with the separate shift handover. The incident date remains under review.',
  ],
  'WC-104': [
    'Examiner diary entry',
    'Diary entry',
    'The new employer representative is available this afternoon. The prior contact has moved to another shift.',
    'Review the contact change at 18:00 UTC on November 17.',
  ],
  'WC-105': [
    'Employer incident report WHS-42',
    'Employer report',
    'Report WHS-42 places River Ellis at Cedar Dock, loading bay three. The reporting supervisor recorded November 9.',
    'The initial report has no caller statement. The examiner should verify the date with the caller.',
  ],
  'WC-106': [
    'Supervisor statement',
    'Witness statement',
    'The supervisor saw Perry stop work at the North Workshop and reported the interruption to the shift lead.',
    'The statement is signed. Compare the account with the employer report.',
  ],
  'WC-107': [
    'Employer incident report WHS-71',
    'Employer report',
    'Report WHS-71 places River Ellis at Alder Yard, in the sorting shed. The reporting supervisor recorded November 10.',
    'The initial report has no caller statement. Confirm the worksite before attaching any incoming correspondence.',
  ],
  'WC-108': [
    'Interpreter booking',
    'Diary entry',
    'A telephone interpreter is booked for November 17 at 16:30 UTC for the callback with Ari.',
    'Have the examiner join the booked callback.',
  ],
  'WC-109': [
    'Clinic visit acknowledgement',
    'Provider note',
    'The clinic confirmed that Kit attended the scheduled visit. The acknowledgement contains no clinical findings.',
    'Review the acknowledgement and follow up on the outstanding clinic narrative.',
  ],
  'WC-110': [
    'Employer liaison note',
    'Contact note',
    'The employer liaison acknowledged the request and expects to send the written incident report on November 18.',
    'Check for the report at 17:00 UTC on November 18.',
  ],
  'WC-111': [
    'Employer follow-up diary',
    'Diary entry',
    'The employer requested a conversation about an available modified assignment. No restrictions have been confirmed.',
    'Prepare questions for the employer call at 20:00 UTC on November 17.',
  ],
  'WC-112': [
    'Witness memo cover sheet',
    'Witness statement',
    'The witness refers to a sketch of the Bench Room. The envelope contained the cover sheet only.',
    'Ask the sender for the referenced sketch.',
  ],
  'WC-113': ['Packing station closing note', 'Closure diary', 'The employer returned the final note and the examiner closed the record.', 'No follow-up is outstanding.'],
  'WC-114': ['Glass shop closing note', 'Closure diary', 'The examiner recorded the final review and closed the record.', 'No follow-up is outstanding.'],
}
for (const item of claims) {
  const [title, kind, account, followup] = reports[item.id]
  const employerReport = kind === 'Employer report'
  const source = employerReport ? `${item.employer} reporting desk` : item.source
  const recorded = employerReport ? `${item.incidentDate}T19:15:00.000Z` : STORY_AS_OF
  register(
    item.documents[0],
    item.id,
    title,
    kind,
    source,
    [
      anchor(
        'identification',
        'Reported incident',
        `${item.claimant} | ${item.employer} | ${item.site}, ${item.jurisdiction}. Reported incident date: ${item.incidentDate}.`,
      ),
      anchor('account', 'Source account', account),
      anchor('followup', 'Follow-up', followup),
    ],
    recorded,
  )
}
register('WC-103-shift', 'WC-103', 'Shift handover note', 'Shift log', 'Employer shift desk', [
  anchor(
    'date',
    'Date in handover',
    'The relief supervisor recorded November 10 in the shift handover. The supervisor incident report gives a different date.',
  ),
  anchor(
    'scope',
    'Verification outstanding',
    'The handover does not establish which date should be entered as the incident date.',
  ),
])
register(
  'IN-201-call',
  intakes[0].id,
  'Inbound call transcript',
  'Call transcript',
  'Voice intake',
  JSON.parse(readFileSync(new URL('../assets/IN-201-transcript.json', import.meta.url), 'utf8')),
  '2026-11-17T13:38:00.000Z',
)
register(
  'IN-202-note',
  intakes[1].id,
  'Unidentified callback message',
  'Intake note',
  'Voice intake',
  [
    anchor('message', 'Caller message', 'Please have someone call me back about the incident at work.'),
    anchor(
      'missing',
      'Identifiers outstanding',
      'No caller name, employer, worksite, callback number, or employer report number was provided. The intake stays in the team queue.',
    ),
  ],
  '2026-11-17T13:47:00.000Z',
)

export const getDocument = (id) => documents.get(id)

const wageSourceAnchorId = 'provenance'

// This projection consumes only the signed, schema-validated response accepted by the adapter.
// The document and its approved citation travel with the returned evidence snapshot.
export function buildWageDocument(
  itemId,
  { requestId, artifact, periodStart = wagePeriod.periodStart, periodEnd = wagePeriod.periodEnd },
) {
  const { data, provenance: wageSource } = artifact
  const { days, requested, gaps } = wageCoverage(data.payPeriods, periodStart, periodEnd)
  const anchors = [
    anchor(
      'coverage',
      'Requested interval',
      `Requested ${periodStart} through ${periodEnd}. Returned payroll records cover ${days} of ${requested} requested days. ${days < requested ? 'Partial coverage.' : 'Full interval covered.'}`,
    ),
  ]
  if (itemId.startsWith('CLM-') && gaps.length) anchors.push(anchor('missing','Uncovered dates',gaps.map(range=>range.join(' through ')).join(', ')))
  for (const [index, p] of data.payPeriods.entries()) {
    const earnings = p.grossEarnings
      ? `Gross earnings ${p.grossEarnings.currency} ${p.grossEarnings.amount}.`
      : 'Gross earnings unavailable.'
    anchors.push(
      anchor(
        `period-${index + 1}`,
        `Pay period ${index + 1}`,
        `${p.periodStart} through ${p.periodEnd}. ${earnings} Regular hours: ${p.hours?.regular ?? 'unavailable'}. Overtime hours: ${p.hours?.overtime ?? 'unavailable'}.`,
      ),
    )
  }
  const breakdown = data.payPeriods.flatMap((period, index) => {
    const values = ['base', 'overtime', 'bonus', 'other'].flatMap((type) => {
      const money = period.earningsByType?.[type]
      return money ? [`${type}: ${money.currency} ${money.amount}`] : []
    })
    return values.length
      ? [anchor(`earnings-${index + 1}`, `Earnings breakdown, period ${index + 1}`, values.join(', ') + '.')]
      : []
  })
  anchors.push(...breakdown)
  anchors.push(
    anchor(
      wageSourceAnchorId,
      'Partner source',
      `Source ${wageSource.sourceSystem}. As of ${wageSource.asOf}. Record IDs: ${wageSource.recordIds.join(', ')}.`,
    ),
  )
  anchors.push(
    anchor(
      'scope',
      'Document scope',
      'This statement records the evidence returned for examiner review. Benefit and payment decisions require a separate process.',
    ),
  )
  return {
    id: `wage-${requestId}`,
    itemId,
    version: 1,
    asOf: wageSource.asOf,
    title: 'Partner wage statement',
    kind: 'Wage statement',
    source: wageSource.sourceSystem,
    anchors,
  }
}
