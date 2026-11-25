import { wageCases } from '../showcase/data/wage-cases.mjs'

// The CMS portfolio and scripted claim records have a mock Juris destination.
export function showcaseCapabilities(item) {
  const juris = item.type === 'claim' && item.source !== 'Wage evidence study'
  return {
    juris,
    intakeTarget: juris && !item.external_claim_number,
    wageRequest: juris && item.lifecycle !== 'closed' && Object.hasOwn(wageCases,item.id),
  }
}
