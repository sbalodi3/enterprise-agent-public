import { getDocument } from '../showcase/data/documents.mjs'
import { STORY_AS_OF } from '../showcase/data/scenario.mjs'

export const asOf = STORY_AS_OF
export const requestQuestion = 'Was a second $600 expense authorized for INV-318, reference EXP-044?'
export const approvedDisposition = {
  disposition: 'no_amendment',
  reference: 'AUTH-600-01',
  text: 'The authorization register records one $600 expense. No second authorization or amendment appears in the register reviewed.',
}

const passage = (id, label, text) => ({ id, label, text })
const document = (id, title, kind, passages) => ({ id, title, kind, version: 1, passages })
const checklist = (label, complete) => ({ label, complete })
const expense = (id, label, reference, cents) => ({ id, label, reference, cents })
const money = (cents) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

function excerpt(id, anchorId) {
  const original = getDocument(id)
  return document(id, original.title, 'Shared claim excerpt', [
    original.anchors.find((anchor) => anchor.id === anchorId),
    passage('recorded', 'Recorded on file', original.asOf),
  ])
}

const report = excerpt('WC-103-report', 'account')
const shift = excerpt('WC-103-shift', 'date')
const heroMatter = {
  department: 'legal',
  id: 'MAT-017',
  title: 'Incident chronology for outside counsel',
  account: 'Rain Arch Glass',
  owner: 'legal',
  status: 'Packet in preparation',
  priority: 'High',
  dueAt: '2026-11-17T20:00:00Z',
  linkedClaimId: 'WC-103',
  reason: 'Two reports identify different incident dates.',
  nextAction: 'Review the source chronology and approve the factual packet.',
  sources: [
    report,
    shift,
    document('REQ-017', 'Outside counsel request', 'Request letter', [
      passage(
        'request',
        'Requested materials',
        'Prepare a factual chronology from the supervisor report and shift handover. Flag the unconfirmed incident date. Return the packet to the matter file by November 17 at 20:00 UTC.',
      ),
    ]),
    document('AUTH-600-01', 'Expense authorization register', 'Billing authorizations', [
      passage(
        'entry',
        'Authorization entry',
        'Invoice INV-318, reference EXP-044. One $600 expense approved. The register review found no second authorization or amendment. Shareable billing reference AUTH-600-01.',
      ),
    ]),
    document('PREP-017', 'Reviewer preparation note', 'Legal team only', [
      passage(
        'note',
        'Internal preparation',
        'Matter team note: discuss interview sequencing with counsel separately. Exclude this note from the factual packet and billing replies.',
      ),
    ]),
  ],
  chronology: [
    {
      date: '2026-11-09',
      label: 'Incident date in supervisor report',
      sourceId: report.id,
      anchorId: 'account',
    },
    { date: '2026-11-10', label: 'Incident date in shift handover', sourceId: shift.id, anchorId: 'date' },
    { date: '2026-11-17', label: 'Shift handover recorded on file', sourceId: shift.id, anchorId: 'recorded' },
  ],
  checklist: [
    checklist('Supervisor report located', true),
    checklist('Shift handover located', true),
    checklist('Independent incident-date confirmation', false),
  ],
}
const otherMatters = [
  [
    'MAT-021',
    'Vendor agreement records request',
    'Northstar Records',
    null,
    '2026-11-18T16:00:00Z',
    'High',
    'The signed amendment is outstanding.',
    'Obtain the signed amendment.',
  ],
  [
    'MAT-023',
    'Document index for counsel',
    'Willow Arc',
    'WC-106',
    '2026-11-19T18:00:00Z',
    'Normal',
    'The document index is ready for review.',
    'Review the index against the request.',
  ],
  [
    'MAT-025',
    'Witness statement request',
    'Millstone Works',
    null,
    '2026-11-20T17:00:00Z',
    'Normal',
    'The witness statement has not been received.',
    'Follow up with the assigned records contact.',
  ],
  [
    'MAT-031',
    'Source inventory review',
    'Harbor Mill',
    null,
    '2026-11-23T19:00:00Z',
    'Normal',
    'The source custodian supplied the requested inventory.',
    'Compare the inventory with the request.',
  ],
  [
    'MAT-034',
    'Correspondence packet',
    'Oriel Industrial',
    null,
    '2026-11-24T20:00:00Z',
    'Low',
    'A dated correspondence index is outstanding.',
    'Request the dated index.',
  ],
].map(([id, title, account, linkedClaimId, dueAt, priority, reason, nextAction]) => {
  const complete = !/outstanding|not been received/.test(reason)
  return {
    department: 'legal',
    id,
    title,
    account,
    linkedClaimId,
    dueAt,
    priority,
    reason,
    nextAction,
    owner: 'legal',
    status: complete ? 'Ready for review' : 'Awaiting source',
    sources: [
      document(id + '-request', title, 'Matter intake', [
        passage('scope', 'Request from matter team', reason + ' ' + nextAction),
        passage('due', 'Requested by', dueAt),
      ]),
    ],
    chronology: [],
    checklist: [checklist('Requested source received', complete)],
  }
})

function billingDocument(id, title, kind, rows) {
  return document(
    id,
    title,
    kind,
    rows.map((row) => passage(row.id, row.label, row.reference + ' · ' + money(row.cents))),
  )
}

function billingRecord({
  id,
  title,
  account,
  invoiceId,
  invoiceRows,
  stagedRows,
  linkedClaimId = null,
  dueAt,
  priority,
  reason,
  nextAction,
}) {
  const stagedId = id + '-staged'
  const rowsWithRef = (rows, sourceId) => rows.map((row) => ({ ...row, sourceId, anchorId: row.id }))
  return {
    department: 'finance',
    id,
    title,
    account,
    linkedClaimId,
    dueAt,
    priority,
    reason,
    nextAction,
    owner: 'finance',
    status: 'Needs reconciliation',
    sources: [
      billingDocument(invoiceId, 'Supplier invoice ' + invoiceId, 'Invoice', invoiceRows),
      billingDocument(stagedId, 'Staged client bill', 'Staged billing lines', stagedRows),
    ],
    invoiceRows: rowsWithRef(invoiceRows, invoiceId),
    stagedRows: rowsWithRef(stagedRows, stagedId),
  }
}
const heroBilling = billingRecord({
  id: 'FIN-207',
  title: 'Outside counsel expense reconciliation',
  account: 'Rain Arch Glass',
  linkedClaimId: 'WC-103',
  invoiceId: 'INV-318',
  dueAt: '2026-11-17T21:00:00Z',
  priority: 'High',
  reason: 'The same expense reference appears twice on the staged bill.',
  nextAction: 'Compare the expense lines and ask Legal to verify the authorization.',
  invoiceRows: [
    expense('fee', 'Counsel fees', 'FEE-318', 840000),
    expense('expense', 'Document services', 'EXP-044', 60000),
  ],
  stagedRows: [
    expense('fee', 'Counsel fees', 'FEE-318', 840000),
    expense('expense-1', 'Document services', 'EXP-044', 60000),
    expense('expense-2', 'Additional expense line', 'EXP-044', 60000),
  ],
})
const otherBilling = [
  [
    'FIN-212',
    'Monthly retainer exception',
    'Northstar Records',
    'INV-422',
    'RET-011',
    370000,
    390000,
    '2026-11-18T16:00:00Z',
    'High',
  ],
  [
    'FIN-215',
    'Courier allocation',
    'Willow Arc',
    'INV-446',
    'CRT-031',
    36000,
    27600,
    '2026-11-19T18:00:00Z',
    'Normal',
  ],
  [
    'FIN-218',
    'Translation services variance',
    'Millstone Works',
    'INV-459',
    'TRN-117',
    98000,
    109000,
    '2026-11-20T19:00:00Z',
    'Normal',
  ],
  [
    'FIN-226',
    'Records retrieval fee',
    'Harbor Mill',
    'INV-480',
    'REC-230',
    28400,
    24800,
    '2026-11-23T17:00:00Z',
    'Normal',
  ],
  [
    'FIN-230',
    'Storage service billing',
    'Oriel Industrial',
    'INV-486',
    'STR-014',
    125000,
    130000,
    '2026-11-24T20:00:00Z',
    'Low',
  ],
].map(([id, title, account, invoiceId, reference, billed, staged, dueAt, priority]) =>
  billingRecord({
    id,
    title,
    account,
    invoiceId,
    dueAt,
    priority,
    reason: 'The staged line differs from the supplier invoice.',
    nextAction: 'Review the source lines before billing release.',
    invoiceRows: [expense('line', 'Invoiced service', reference, billed)],
    stagedRows: [expense('line', 'Staged service', reference, staged)],
  }),
)

export const records = [heroMatter, ...otherMatters, heroBilling, ...otherBilling]
