// Invented people and businesses. A fixed shift makes due times repeatable across demonstrations.
export const STORY_AS_OF = '2026-11-17T14:00:00.000Z'
export const wagePeriod = { periodStart: '2025-11-14', periodEnd: '2026-11-12' }

const portfolio = [
  ['WC-101', 'maya', 'Blair Dale', 'Bell Fern Studio', 'Kiln Room', '2026-11-06', 'Promised callback', 'Diary', 'Callback promised for 15:00 UTC this shift.', 'Prepare callback', '2026-11-17T15:00:00Z'],
  ['WC-102', 'maya', 'Jamie Rowan', 'Slate Harbor Fulfillment', 'Elm Depot', '2026-11-13', 'Wage evidence request', 'Wage service', 'Payroll evidence is missing from the incident file.', 'Request wage evidence', null],
  ['WC-103', 'alex', 'Linden Ames', 'Rain Arch Glass', 'Furnace Hall', '2026-11-09', 'Conflicting incident dates', 'Claim activity', 'Supervisor report cites November 9. The shift note cites November 10.', 'Review source dates', null],
  ['WC-104', 'alex', 'Rory Venn', 'Orchard Loom Works', 'Loom Hall', '2026-11-03', 'Diary review', 'Diary', 'Updated employer contact details need a diary review.', 'Review diary', '2026-11-17T18:00:00Z'],
  ['WC-105', 'maya', 'River Ellis', 'Willow Harbor Supply', 'Cedar Dock', '2026-11-09', 'Cedar Dock incident', 'Employer report', 'Loading bay three report WHS-42 has no caller statement.', 'Review incident report', null],
  ['WC-106', 'alex', 'Perry Finch', 'Violet Spoke Repair', 'North Workshop', '2026-11-07', 'Supervisor statement', 'Document desk', 'A signed supervisor statement is ready for comparison.', 'Read statement', null],
  ['WC-107', 'maya', 'River Ellis', 'Willow Harbor Supply', 'Alder Yard', '2026-11-10', 'Alder Yard incident', 'Employer report', 'Sorting shed report WHS-71 has no caller statement.', 'Review incident report', null],
  ['WC-108', 'alex', 'Ari Pike', 'Snowcap Book Bindery', 'Press Room', '2026-11-05', 'Interpreter callback', 'Diary', 'Interpreter availability is confirmed for 16:30 UTC.', 'Prepare callback', '2026-11-17T16:30:00Z'],
  ['WC-109', 'maya', 'Kit Hart', 'Otter Fern Goods', 'East Annex', '2026-11-04', 'Clinic visit note', 'Document desk', 'The received visit note needs examiner review.', 'Read visit note', null],
  ['WC-110', 'alex', 'Jules Avery', 'Ash Lace Ceramics', 'Glaze Room', '2026-11-12', 'Employer report outstanding', 'Employer liaison', 'Employer has promised the written report tomorrow.', 'Check employer response', '2026-11-18T17:00:00Z'],
  ['WC-111', 'maya', 'Casey Moss', 'Silver Reed Printworks', 'Finishing Floor', '2026-11-02', 'Return-to-work follow-up', 'Diary', 'The employer contact requested an afternoon status call.', 'Prepare follow-up', '2026-11-17T20:00:00Z'],
  ['WC-112', 'alex', 'Drew Hale', 'Little Star Assembly', 'Bench Room', '2026-11-11', 'Missing witness attachment', 'Document desk', 'A witness memo refers to an attachment still outstanding.', 'Check attachment', null],
  ['WC-113', 'maya', 'Devin Rowan', 'Brook Pine Print', 'Packing Station', '2026-09-02', 'Packing station closure', 'Closure diary', 'Final employer note received and reviewed.', 'No outstanding actions', null, 'closed'],
  ['WC-114', 'alex', 'Sam Ellery', 'Juniper Glassworks', 'Glass Shop', '2026-08-24', 'Glass shop closure', 'Closure diary', 'Final examiner review completed.', 'No outstanding actions', null, 'closed'],
]

const reviewStates = new Map([
  ...['WC-103', 'WC-104', 'WC-106', 'WC-109'].map(id => [id, 'review']),
  ['WC-110', 'waiting'], ['WC-112', 'waiting'],
])

export const claims = portfolio.map(([id, ownerId, claimant, employer, site, incidentDate, title, source, reason, nextAction, dueAt, lifecycle = 'open']) => ({
  id, ownerId, type: 'claim', claimant, employer, site, incidentDate, jurisdiction: 'OH', title, source, reason, nextAction, dueAt, lifecycle,
  state: reviewStates.get(id) ?? 'ready', asOf: STORY_AS_OF,
  documents: [`${id}-report`, ...(id === 'WC-103' ? ['WC-103-shift'] : [])],
}))

export const intakes = [
  { id: 'IN-201', ownerId: 'maya', title: 'Cedar Dock caller intake', claimant: 'River Ellis', employer: 'Willow Harbor Supply', site: 'Cedar Dock', reason: 'Two files match the caller name and employer. Verify the worksite and report number.', nextAction: 'Match call to claim', documents: ['IN-201-call'], candidateIds: ['WC-105', 'WC-107'] },
  { id: 'IN-202', ownerId: 'claims-intake', title: 'Unidentified callback request', claimant: null, employer: null, site: null, reason: 'The caller left neither a name nor a report number.', nextAction: 'Request identifying details', documents: ['IN-202-note'], candidateIds: [] },
].map((item) => ({ type: 'intake', incidentDate: null, source: 'Voice intake', dueAt: null, state: 'ready', asOf: STORY_AS_OF, ...item }))
