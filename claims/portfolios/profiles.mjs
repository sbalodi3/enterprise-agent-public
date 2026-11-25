/** Local department releases. The authenticated principal and the store determine record access. */
export const departmentProfiles = Object.freeze({
  legal: {
    id: 'legal',
    storageProfile: 'legal-v1',
    name: 'Legal Matters',
    release: '1.0.0',
    recordType: 'matter',
    actions: ['approve_packet', 'request_confirmation', 'reply_finance'],
  },
  finance: {
    id: 'finance',
    storageProfile: 'finance-v1',
    name: 'Finance Billing Review',
    release: '1.0.0',
    recordType: 'billing exception',
    actions: ['open_review', 'ask_legal'],
  },
})
