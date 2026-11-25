import { claims, wagePeriod } from './scenario.mjs'
import { CMS_USERS, DEMO_USERS } from '../../auth/roster.mjs'
const original = claims.find(c => c.id === 'WC-102')
export const wageCases = {
  'WC-102': { associateName:original.claimant, state:original.jurisdiction, dateOfInjury:original.incidentDate,
    dateRangeStart:wagePeriod.periodStart, dateRangeEnd:wagePeriod.periodEnd },
  'CLM-000020': { associateName:'Daniel Smith', state:'MA', dateOfInjury:'2024-12-06',dateRangeStart:'2023-12-08',dateRangeEnd:'2024-12-05' },
  'CLM-000002': { associateName:'Richard Hall', state:'IL', dateOfInjury:'2024-02-04',dateRangeStart:'2023-02-05',dateRangeEnd:'2024-02-03' },
}
export function wageDisclosure(id, actor) {
  const employee = [...DEMO_USERS,...CMS_USERS].find(e => e.principalId === actor)
  if (!employee || !Object.hasOwn(wageCases,id)) return null
  return {tpaName:'Sedgwick',requestType:'52-week-wage-history',adjusterName:employee.displayName,adjusterEmail:employee.upn,
    claimNumber:id,...wageCases[id],additionalDetails:'Review synthetic wage evidence for the requested period'}
}
export function employmentSupplement(id) {
  const w = wageCases[id]
  return {id:id+'-employment',itemId:id,version:1,kind:'Employer report',title:'Employment and injury supplement',
    source:'Synthetic employer verification',asOf:w.dateOfInjury+'T17:00:00.000Z',
    anchors:[{id:'employment',label:'Verified employment and injury',text:
      w.associateName+' was working for the synthetic Amazon employer in '+w.state+' when injured on '+w.dateOfInjury+
      (id==='CLM-000020' ? ' while responding to the reported burst pipe.' : ' while securing the site after the reported hailstorm.')},
      {id:'followup',label:'Payroll needed',text:'Request payroll from '+w.dateRangeStart+' through '+w.dateRangeEnd+' to document pre-injury wages.'}]}
}
