// Workforce directory IDs and workbench subjects have independent lifetimes.
export const baselineTenant = 'db5ec091-9b12-4b56-8c34-010000000001'
export const showcaseTenant = 'db5ec091-9b12-4b56-8c34-010000000002'
export const workbenchClient = 'ebcba8a9-c95f-486a-a89a-f09178e9455d'
const employees = [
  ['maya', 'Maya Chen', 'claims-v1', '5e759d8b-0cab-460f-a32e-000000000001', '4da07d87-e850-4646-9187-170000000001'],
  ['alex', 'Alex Rivera', 'claims-v1', '5e759d8b-0cab-460f-a32e-000000000002', '4da07d87-e850-4646-9187-170000000002'],
  ['supervisor', 'Jordan Lee', 'claims-v1', '5e759d8b-0cab-460f-a32e-000000000003', '4da07d87-e850-4646-9187-170000000003'],
  ['legal', 'Morgan Ellis', 'legal-v1', '5e759d8b-0cab-460f-a32e-000000000004', '4da07d87-e850-4646-9187-170000000004'],
  ['finance', 'Sam Patel', 'finance-v1', '5e759d8b-0cab-460f-a32e-000000000005', '4da07d87-e850-4646-9187-170000000005'],
].map(([principalId, displayName, profile, subject, objectId]) => Object.freeze({
  principalId, displayName, profile, subject, objectId, tenantId: 'demo', upn: principalId + '@example.test',
}))

export const DEMO_USERS = Object.freeze(employees.filter(employee => employee.profile === 'claims-v1'))
// CMS-MCP bfa4bfce: stable source IDs, independent of subsequent Workbench transfers.
const adjusterNames = ['Aisha Khan', 'Brandon Lee', 'Catalina Suarez', 'Devon Walsh', 'Esi Mensah',
  'Farid Haidari', 'Gianna Russo', 'Hiroshi Yamada', 'Iman Ali', 'Jasper Becker', 'Kara Petersen',
  'Liang Wu', 'Mira Joshi', 'Niko Andreou', 'Omar Saleh', 'Penelope Marsh', 'Quinn Halloran',
  'Rafael Cordero', 'Saoirse Byrne', 'Tomas Velasquez']
export const CMS_USERS = Object.freeze([...adjusterNames, 'Claims Administrator'].map((displayName, index) => {
  const number = index + 1
  const admin = number > adjusterNames.length
  const suffix = String(number).padStart(12, '0')
  const principalId = admin ? 'claims-admin' : 'cms-adjuster-' + String(number).padStart(2, '0')
  return Object.freeze({ principalId, displayName, profile: 'claims-v1', tenantId: 'demo',
    objectId: 'de3378b7-d374-414f-8440-' + suffix, subject: '1d128183-a7aa-4e83-8b79-' + suffix,
    upn: principalId + '@example.test', sourceAdjusterId: admin ? null : number,
    role: admin ? 'claims_admin' : 'adjuster' })
}))
export function directory(showcase, cms = process.env.CLAIMS_CMS_MCP === '1') {
  return { tenant: showcase ? showcaseTenant : baselineTenant,
    employees: showcase ? (cms ? [...employees, ...CMS_USERS] : employees) : DEMO_USERS }
}
