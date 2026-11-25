import { wageCoverage } from '../domain/wage-coverage.mjs'
import { DomainError } from '../domain/index.mjs'

const requestPattern = /^Requested (\d{4}-\d\d-\d\d) through (\d{4}-\d\d-\d\d)\./
const periodPattern = /^(\d{4}-\d\d-\d\d) through (\d{4}-\d\d-\d\d)\. (.+)$/
export const wageQuestion = question => /\b(wage|wages|payroll|pay periods?)\b/i.test(question) &&
  /\b(review|missing|gap|gaps|coverage|covered|complete|conflict|disagree|outstanding|lack|needed)\b/i.test(question)

// Payroll returns can express the same decimal amount with different precision.
function payrollValues(account) {
  const number = value => value?.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
  const gross = /Gross earnings ([A-Z]{3}) (-?\d+(?:\.\d+)?)\./.exec(account)
  return {
    gross: gross && gross[1] + ' ' + number(gross[2]),
    regular: number(/Regular hours: (-?\d+(?:\.\d+)?)\./.exec(account)?.[1]),
    overtime: number(/Overtime hours: (-?\d+(?:\.\d+)?)\./.exec(account)?.[1]),
  }
}

/** Read published, versioned passages; original partner verification packets stay on the server. */
export async function readWageReview(docs, readPassage) {
  const facts = [], sources = [], requests = new Map(), periods = [], accounts = new Map()
  let incomplete = false
  function add(component, text, refs) {
    facts.push({ id: 'fact_' + (facts.length + 1), component, text, refs: [...new Set(refs)] })
  }
  for (const doc of docs) {
    const wage = doc.kind === 'Wage statement' || doc.kind === 'Wage evidence request'
    const anchors = doc.anchors ?? []
    const periodOffset = periods.length
    let declared
    if (wage && !anchors.some(a => a.id === 'coverage' || /^period-\d+$/.test(a.id))) {
      incomplete = true
      if (anchors.length) {
        const { ref } = await readPassage(doc, anchors[0].id)
        add('Gap', 'Verify the payroll dates in this document before assessing coverage.', [sources.push(ref) - 1])
      } else add('Gap', 'A payroll document has no citable passage. Inspect the claim inventory.', [])
    }
    for (const anchor of anchors) {
      if (!(wage && (anchor.id === 'coverage' || /^period-\d+$/.test(anchor.id))) &&
          !(doc.kind === 'Employer report' && anchor.id === 'followup')) continue
      const { text, ref } = await readPassage(doc, anchor.id)
      if (!text) throw new DomainError(409, 'stale_version')
      if (!wage && !/\b(payroll|wages?)\b/i.test(text)) continue
      const index = sources.push(ref) - 1
      if (!wage) { add('Coverage', text, [index]); continue }
      const match = text.match(anchor.id === 'coverage' ? requestPattern : periodPattern)
      if (!match) { incomplete = true; add('Gap', 'Verify this source passage before assessing coverage.', [index]); continue }
      const [, from, to, account] = match
      try { wageCoverage([], from, to) } catch (error) {
        if (!(error instanceof RangeError)) throw error
        incomplete = true; add('Gap', 'The reported interval requires verification.', [index]); continue
      }
      const key = from + ' through ' + to
      if (anchor.id === 'coverage') {
        const tally = /Returned payroll records cover (\d+) of (\d+) requested days\./.exec(text)
        if (tally) declared = { from, to, days: Number(tally[1]), requested: Number(tally[2]), index }
        const refs = requests.get(key) || []
        refs.push(index); requests.set(key, refs)
      } else {
        periods.push({ periodStart: from, periodEnd: to, index })
        const entries = accounts.get(key) || []
        entries.push({ account, index, values: payrollValues(account) }); accounts.set(key, entries)
      }
    }
    if (declared) {
      const local = periods.slice(periodOffset)
      const total = wageCoverage(local, declared.from, declared.to)
      if (total.days !== declared.days || total.requested !== declared.requested) {
        incomplete = true
        add('Disagreement', 'The source coverage total and its itemized pay periods do not agree. Verify the return.',
          [declared.index, ...local.map(p => p.index)])
      }
    } else if (doc.kind === 'Wage statement' && periods.length === periodOffset) {
      incomplete = true
    }
  }
  for (const [interval, entries] of accounts) {
    if (['gross','regular','overtime'].some(field => new Set(entries.map(e => e.values[field]).filter(Boolean)).size > 1))
      add('Disagreement', 'Sources give different payroll details for ' + interval + '. ' +
        entries.map(e => sources[e.index].title + ' reports: ' + e.account).join(' '), entries.map(e => e.index))
  }
  for (const [interval, refs] of requests) add('Coverage', 'Requested ' + interval + '.', refs)
  if (requests.size > 1) add('Disagreement', 'Sources specify different requested intervals. Confirm which request applies.', [...requests.values()].flat())
  if (requests.size === 1 && !incomplete) {
    const [[interval, requestRefs]] = requests
    const [start, end] = interval.split(' through ')
    const result = wageCoverage(periods, start, end)
    const refs = [...requestRefs, ...periods.map(p => p.index)]
    const covered = result.covered.map(range => range.join(' through ')).join(', ')
    add('Coverage', result.days + ' of ' + result.requested + ' requested days documented.' + (covered ? ' Covered: ' + covered + '.' : ''), refs)
    for (const range of result.gaps) add('Gap', 'No returned period in this review covers ' + range.join(' through ') + '.', refs)
  } else {
    if (!requests.size) add('Gap', 'The exact requested interval cannot be established from the available passages.', sources.map((_, i) => i))
    else if (incomplete) add('Gap', 'Coverage cannot be established until the payroll details are verified.', sources.map((_, i) => i))
    for (const [interval, entries] of accounts) add('Coverage', 'Reported pay period: ' + interval + '.', entries.map(e => e.index))
  }
  return { facts, sources }
}

export function wageAnswer(review, proposal) {
  const ids = proposal?.order
  const accepted = Array.isArray(ids) && ids.length === review.facts.length && new Set(ids).size === ids.length &&
    ids.every(id => review.facts.some(f => f.id === id))
  const facts = accepted ? ids.map(id => review.facts.find(f => f.id === id)) : review.facts
  const components = []
  for (const fact of facts) {
    components.push({ id: fact.id, component: fact.component, text: fact.text })
    for (const index of fact.refs) {
      const ref = review.sources[index]
      components.push({ id: fact.id + '_source_' + index, component: 'SourceLink', index,
        label: ref.title + ' · ' + ref.anchorId })
    }
  }
  const root = { id: 'root', component: 'Column', children: components.map(row => row.id) }
  const messages = [{ version: '1.0', createSurface: { surfaceId: 'wage', catalogId: 'urn:claims:wage-review:v1' } },
    { version: '1.0', updateComponents: { surfaceId: 'wage', components: [root, ...components] } }]
  return { text: facts.map(f => f.text).join('\n'), sources: review.sources,
    wageReview: { version: 1, layout: accepted ? 'model' : 'fixed', messages } }
}
