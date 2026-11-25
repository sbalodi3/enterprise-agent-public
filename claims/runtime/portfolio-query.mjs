import { directory } from '../auth/roster.mjs'
import { claimSourceStatuses } from '../domain/claim-access.mjs'

const employees = directory(true, true).employees.filter(person => person.profile === 'claims-v1')
const owners = employees.map(person => {
  const full = person.displayName.toLowerCase()
  const first = full.split(' ')[0]
  const unique = employees.filter(other => other.displayName.toLowerCase().split(' ')[0] === first).length === 1
  return { id: person.principalId, aliases: [full, person.principalId, ...(unique && person.sourceAdjusterId ? [first] : [])] }
})

// Leave unsupported qualifiers (e.g. "interpreter") to the agent's search. Dropping
// an unknown word here could incorrectly certify a count over a broader cohort.
const listingWords = new Set((
  'a across active adjuster adjusters all an and any are as assigned at available bring by can case cases caseload ' +
  'claim claims closed count could currently day deadline deadlines do does due end everyone everybody ' +
  'find for from full generate get give has have how i in inventory is later list many me mine my number of on open our ' +
  'out people please portfolio produce provide pull queue remaining return scheduled ' +
  'show someone still s tally tell that the their there these this those to today together total up us waiting what which with would you'
).split(/\s+/))
const linePatterns = [
  [/\b(?:personal and commercial|commercial and personal) auto(?:mobile)?\b/gi, ['AUTO', 'COMM_AUTO']],
  [/\b(?:commercial[ -]auto(?:mobile)?|comm_auto)\b/gi, ['COMM_AUTO']],
  [/\bpersonal[ -]auto(?:mobile)?\b/gi, ['AUTO']],
  [/\bauto(?:mobile)?\b/gi, ['AUTO', 'COMM_AUTO']],
  [/\b(?:workers?['’]?\s*comp(?:ensation)?|wc)\b/gi, ['WC']],
  [/\bhomeowners?\b|\bhome\b/gi, ['HOME']],
  [/\b(?:property\s*(?:and|&)\s*casualty|p\s*&\s*c|pc)\b/gi, ['PC']],
  [/\bhealth\b/gi, ['HEALTH']],
]
const grouped = /\b(?:by|per|grouped (?:by|on)) (?:source status|status|adjuster|lines? of business|business lines?)\b|\b(?:portfolio summary|billings?|litigated count)\b/i

function extractFilters(question) {
  let remaining = question.toLowerCase().replace(/['’]s\b/g, ' ')
  const ownerIds = new Set()
  for (const owner of owners) {
    for (const alias of owner.aliases) {
      const pattern = new RegExp('\\b' + alias + '\\b', 'g')
      remaining = remaining.replace(pattern, () => { ownerIds.add(owner.id); return ' ' })
    }
  }
  remaining = remaining.replace(/\bcms-adjuster-\d{2}\b/g, id => { ownerIds.add(id); return ' ' })
  const lines = new Set()
  for (const [pattern, values] of linePatterns) {
    remaining = remaining.replace(pattern, () => { for (const value of values) lines.add(value); return ' ' })
  }
  const statuses = []
  for (const value of claimSourceStatuses) {
    const qualifier = 'source status(?: is| of)?[ :=]+'
    const prefix = ['Open', 'Closed'].includes(value) ? qualifier : '(?:' + qualifier + ')?'
    remaining = remaining.replace(new RegExp('\\b' + prefix + value + '\\b', 'gi'), () => { statuses.push(value); return ' ' })
  }
  return { ownerIds: [...ownerIds], lines: [...lines].sort(), statuses: [...new Set(statuses)], remaining }
}

export function portfolioDimensions(question) {
  const { ownerIds, lines, statuses } = extractFilters(question)
  return { ownerIds, lines, statuses }
}

/** Turn a complete cohort request into the same filter set used for execution and verification. */
export function parsePortfolioQuery(question, previous) {
  if (typeof question !== 'string' || !question.trim() || /[`"“”\n]|\b(?:or|except|exclude|without|not|example|hypothetical)\b/i.test(question)) return null
  const q = question.trim().replaceAll('’', "'")
  const count = /\b(?:how many|count|number|tally|total)\b/i.test(q)
  if (previous?.kind === 'portfolio' && previous.filters && count) {
    const followup = q.toLowerCase().replace(/[?.! ]+$/, '').replace(/^(?:(?:and|please|so|then|can you|could you|what(?:'s| is)|give me|show me|tell me)\s+)*/, '')
    if (/^(?:how many(?: (?:of )?(?:those|them|these))?(?: (?:are (?:there|those|these)|is that))?|(?:the |a )?(?:count|total|number)(?: (?:of )?(?:them|these|those))?)$/.test(followup))
      return { kind: 'portfolio', operation: 'count', filters: { ...previous.filters } }
    if (/^how many (?:of (?:those|them|these) )?(?:are mine|are assigned to me|do i have)$/.test(followup))
      return { kind: 'portfolio', operation: 'count', filters: { ...previous.filters, assignedOnly: true } }
  }
  if (!/\b(?:claims|cases|caseload|portfolio)\b/i.test(q)) return null
  if (grouped.test(q)) return null
  const { ownerIds, lines, statuses, remaining } = extractFilters(q)
  if (ownerIds.length > 1 || statuses.length > 1) return null
  const residual = lines.length ? remaining.replace(/\b(?:line of business|business line)\b/g, ' ') : remaining
  const words = residual.match(/[\p{L}\p{N}]+/gu) || []
  if (words.some(word => !listingWords.has(word))) return null
  const open = /\b(?:open|active)\b/i.test(remaining)
  const closed = /\bclosed\b/i.test(remaining)
  const dueToday = /\b(?:due|deadlines?)\b/i.test(q) && /\btoday\b/i.test(q)
  const waitingOnly = /\bwaiting\b/i.test(q)
  if ((open && closed) || (/\b(?:due|deadlines?|today)\b/i.test(q) && !dueToday)) return null
  const assignedOnly = /\b(?:my|mine|i have|do i have|assigned to me)\b/i.test(q)
  const status = closed || statuses[0] === 'Closed' ? 'closed' : open || dueToday || waitingOnly || statuses[0] === 'Open' ? 'open' : 'all'
  return {
    kind: 'portfolio', operation: count ? 'count' : 'list',
    filters: { status, assignedOnly, ...(ownerIds.length && { ownerId: ownerIds[0] }),
      ...(lines.length === 1 ? { lob: lines[0] } : lines.length > 1 ? { lobs: lines } : {}),
      ...(statuses.length && { sourceStatus: statuses[0] }), ...(dueToday && { dueToday }), ...(waitingOnly && { waitingOnly }) },
  }
}

// Only the employee's description is sent to this planning call. The original
// text must still describe the same cohort after applying its proposed meanings.
const meanings = {
  operation: { list: 'list', count: 'count' },
  lifecycle: { open: 'open', closed: 'closed', all: 'all' },
  assignment: { mine: 'assigned to me', visible: 'all' },
  line: { auto: 'auto', AUTO: 'personal auto', COMM_AUTO: 'commercial auto', WC: 'workers comp',
    HOME: 'homeowners', HEALTH: 'health', PC: 'property and casualty' },
  queue: { dueToday: 'due today', waitingOnly: 'waiting' },
  sourceStatus: Object.fromEntries(claimSourceStatuses.map(value => [value, 'source status ' + value])),
}

export const portfolioPlanningInstructions = [
  'Interpret a request to list or count claims. Return JSON with operation ("list" or "count"), phrases (array) and unsupported (array).',
  'Translate only phrases needed to describe the requested operation or filter. Each phrase has field, value, and text copied exactly from the request. Keep fragments short and non-overlapping.',
  'Allowed fields and values: ' + JSON.stringify(Object.fromEntries(Object.entries(meanings).map(([field, entries]) => [field, Object.keys(entries)]))),
  'Bare auto means both commercial and personal (line value auto). A named owner may remain as written in the request. Leave ordinary words like "my", "open", "auto" alone unless needed.',
  'Map "on my desk" to assignment mine, for example. Use operation phrases to account for conversational ways to request a list or count. Never put a condition inside an operation phrase.',
  'If any condition is unsupported or its meaning is ambiguous, copy that description into unsupported. Do not infer data, silently omit a condition, or treat an unsupported condition as a keyword search.',
].join('\n')

const normalizePhrase = value => value.normalize('NFKC').toLowerCase().replaceAll('’', "'")

function interpretedPortfolio(question, proposal, previous) {
  if (!proposal || !Object.hasOwn(meanings.operation, proposal.operation) ||
      !Array.isArray(proposal.phrases) || proposal.phrases.length > 12 ||
      !Array.isArray(proposal.unsupported) || proposal.unsupported.length) return null
  const input = normalizePhrase(question)
  const fragments = []
  for (const fragment of proposal.phrases) {
    if (!fragment || !Object.hasOwn(meanings, fragment.field) || !Object.hasOwn(meanings[fragment.field], fragment.value) ||
        typeof fragment.text !== 'string' || !fragment.text.trim() || fragment.text.length > 120) return null
    const phrase = normalizePhrase(fragment.text.trim())
    const start = input.indexOf(phrase), end = start + phrase.length
    if (start < 0 || input.indexOf(phrase, end) !== -1 || /[\p{L}\p{N}_]/u.test(input[start - 1] || '') ||
        /[\p{L}\p{N}_]/u.test(input[end] || '')) return null
    if (fragment.field === 'operation' && (fragment.value !== proposal.operation || /\b(?:claims?|cases?|with|involving|where|whose|except|excluding|over|under)\b/.test(phrase))) return null
    fragments.push({ start, end, meaning: meanings[fragment.field][fragment.value] })
  }
  let cursor = 0, reconstructed = ''
  for (const fragment of fragments.sort((a,b) => a.start - b.start)) {
    if (fragment.start < cursor) return null
    reconstructed += input.slice(cursor, fragment.start) + ' ' + fragment.meaning + ' '
    cursor = fragment.end
  }
  const plan = parsePortfolioQuery(reconstructed + input.slice(cursor), previous)
  if (!plan || plan.operation !== proposal.operation) return null
  // Canonical qualifiers in the employee's words take precedence over a model's
  // interpretation. Ambiguous implicit qualifiers cannot erase an explicit one.
  const explicit = extractFilters(input)
  const filters = plan.filters
  const lines = filters.lobs || (filters.lob ? [filters.lob] : [])
  if (explicit.lines.some(line => !lines.includes(line)) || explicit.ownerIds.some(owner => owner !== filters.ownerId) ||
      explicit.statuses.some(status => status !== filters.sourceStatus) ||
      (/\b(?:open|active)\b/.test(explicit.remaining) && filters.status !== 'open') ||
      (/\bclosed\b/.test(explicit.remaining) && filters.status !== 'closed') ||
      (/\b(?:my|mine|assigned to me)\b/.test(input) && !filters.assignedOnly) ||
      (/\b(?:count|how many)\b/.test(input) && plan.operation !== 'count')) return null
  return plan
}

/** Resolve cohort requests without reading records. Partial interpretations ask for a supported filter. */
export async function resolvePortfolioQuery(question, previous, interpret, signal) {
  const exact = parsePortfolioQuery(question, previous)
  if (exact) return { scope: {kind: 'portfolio'}, operation: exact }
  if (!/\b(?:claims|cases|portfolio|caseload)\b/i.test(question) ||
      !/\b(?:what|which|how many|number|count|inventory|list|show|provide|produce|give|pull|bring|find|fetch|return|display|retrieve|tally|total|all|breakdown)\b/i.test(question) ||
      grouped.test(question) ||
      /\b(?:compare|comparison|summar(?:y|ies|ize)|timelines?|documents?|reports?|(?:pinned|attached|selected) (?:cases|claims)|(?:wc|clm)-\d+)\b/i.test(question)) return null
  let proposal
  if (interpret) {
    proposal = await interpret(question, signal)
    signal?.throwIfAborted()
  }
  const plan = interpretedPortfolio(question, proposal, previous)
  if (plan) return { scope: {kind: 'portfolio'}, operation: plan }
  const issue = Array.isArray(proposal?.unsupported) && proposal.unsupported.find(
    value => typeof value === 'string' && value.trim() && value.length <= 100 && normalizePhrase(question).includes(normalizePhrase(value)))
  return { question: { kind: 'portfolio', text: (issue ? 'I could not apply “' + issue + '”. ' : '') +
    'Which claims should I include? Restate the list or count with a lifecycle, business line, adjuster, source status, or waiting or due-today filter.',
    options: [], allowOther: true } }
}

export function matchesPortfolioFilters(actual, expected, defaultStatus = 'open') {
  if (!actual || actual.offset || (actual.query || '').trim()) return false
  const lines = filters => filters.lobs || (filters.lob ? [filters.lob] : [])
  const actualLines = lines(actual), expectedLines = lines(expected)
  return (actual.status ?? defaultStatus) === expected.status &&
    ['assignedOnly','dueToday','waitingOnly'].every(key => Boolean(actual[key]) === Boolean(expected[key])) &&
    ['ownerId','sourceStatus'].every(key => (actual[key] || '') === (expected[key] || '')) &&
    actualLines.length === expectedLines.length && expectedLines.every(value => actualLines.includes(value))
}
