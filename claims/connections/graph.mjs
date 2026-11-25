import { createGraphClient } from './graph-client.mjs'
import { DomainError } from '../domain/index.mjs'

const fields = 'id,subject,from,receivedDateTime,bodyPreview,webLink'
const budget = 50
const invalid = () => { throw new DomainError(400, 'invalid_mail_search') }
const isoDay = value => new Date(value).toISOString().slice(0, 10)
const days = (day, n) => isoDay(Date.parse(day + 'T00:00:00Z') + n * 86400000)
function checkDay(value) {
  if (!/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(value)) || isoDay(value) !== value) invalid()
  return value
}
function term(value, limit) {
  if (value == null) return ''
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f]/.test(value)) invalid()
  return value.trim().replace(/\s+/gu, ' ')
}

// Find the first instant of a local calendar day, including offset changes at midnight.
function startOfDay(day, formatter) {
  const center = Date.parse(day + 'T00:00:00Z')
  let lo = center - 86400000, hi = center + 86400000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (formatter.format(mid) < day) lo = mid + 1
    else hi = mid
  }
  return new Date(lo).toISOString()
}
export function mailDateRange(input, now = Date.now()) {
  const timeZone = input.timeZone || 'UTC'
  let formatter
  try { formatter = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) }
  catch { invalid() }
  let from = input.from ? checkDay(input.from) : null
  let to = input.to ? checkDay(input.to) : null
  if (!from && !to && input.recent) {
    to = formatter.format(now)
    from = days(to, -29)
  }
  if (from && to && from > to) invalid()
  return { from, to, timeZone, start: from && startOfDay(from, formatter), end: to && startOfDay(days(to, 1), formatter) }
}
function textOf(body) {
  const value = String(body?.content || '')
  if (body?.contentType?.toLowerCase() === 'text') return value
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim()
}
function message(row) {
  if (!row || typeof row.id !== 'string' || !row.id || !Number.isFinite(Date.parse(row.receivedDateTime)))
    throw new DomainError(502, 'invalid_graph_message')
  let webLink = null
  if (row.webLink) {
    try {
      const url = new URL(row.webLink)
      if (url.protocol === 'https:' && !url.username && !url.password &&
        ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.cloud.microsoft'].includes(url.hostname)) webLink = url.href
    } catch { /* A missing or malformed optional link does not invalidate a match. */ }
  }
  const sender = row.from?.emailAddress || {}
  return { id: row.id, subject: String(row.subject || '(No subject)').slice(0, 512),
    from: [sender.name, sender.address].filter(Boolean).filter((x,i,a) => a.indexOf(x) === i).join(' · ').slice(0, 512),
    receivedAt: new Date(row.receivedDateTime).toISOString(), excerpt: String(row.bodyPreview || '').slice(0, 350), webLink }
}
function restrictions(sender, subject, range) {
  // Collection search accepts day-resolution restrictions. Widen UTC dates at the edges,
  // then enforce the actual half-open local interval on each returned message.
  return [sender && 'from:' + JSON.stringify(sender), subject && 'subject:' + JSON.stringify(subject),
    range.start && 'received>=' + range.start.slice(0,10), range.end && 'received<=' + range.end.slice(0,10)].filter(Boolean)
}
function accepts(row, range, sender, subject) {
  const senderInfo = row.from?.emailAddress || {}
  const matchSender = !sender || (sender.includes('@') ? senderInfo.address?.toLowerCase() === sender.toLowerCase() :
    [senderInfo.address, senderInfo.name].some(s => s?.toLowerCase().includes(sender.toLowerCase())))
  const when = Date.parse(row.receivedDateTime)
  return matchSender && (!subject || row.subject?.toLowerCase().includes(subject.toLowerCase())) &&
    (!range.start || when >= Date.parse(range.start)) && (!range.end || when < Date.parse(range.end))
}
const recentFirst = (a,b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id)
async function collection(client, params, matches, endpoint = '/v1.0/me/messages') {
  let path = endpoint + '?' + params
  let count = 0
  const seen = new Set()
  const rows = []
  while (path && count < budget && seen.size < budget) {
    if (seen.has(path)) throw new DomainError(502, 'invalid_graph_page')
    seen.add(path)
    const page = await client.request(path)
    if (!Array.isArray(page.value)) throw new DomainError(502, 'invalid_graph_page')
    const slice = page.value.slice(0, budget - count)
    rows.push(...slice.filter(matches))
    count += slice.length
    if (slice.length < page.value.length) return { rows, partial: true }
    path = page['@odata.nextLink']
    if (path && new URL(path, client.origin).pathname.toLowerCase() !== endpoint.toLowerCase()) throw new DomainError(502, 'invalid_graph_page')
  }
  return { rows, partial: !!path }
}
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
/** Search only the mailbox represented by this employee's token. */
export async function searchOutlook(lease, input, options = {}) {
  const client = createGraphClient(lease, options)
  const range = mailDateRange(input, options.now)
  const query = term(input.query, 300), sender = term(input.sender, 180), subject = term(input.subject, 180)
  const order = input.order || 'best'
  if (!['best','latest'].includes(order)) invalid()
  const matches = row => accepts(row, range, sender, subject)
  const filters = restrictions(sender, subject, range)
  const words = query.split(' ').filter(Boolean)
  let rows, partial
  if (input.folder !== undefined && input.folder !== 'inbox' || input.unreadOnly !== undefined && typeof input.unreadOnly !== 'boolean') invalid()
  if (input.folder || input.unreadOnly) {
    const endpoint = input.folder === 'inbox' ? '/v1.0/me/mailFolders/inbox/messages' : '/v1.0/me/messages'
    const clauses = ['receivedDateTime ge ' + (range.start || '0001-01-01T00:00:00Z')]
    if (range.end) clauses.push('receivedDateTime lt ' + range.end)
    if (input.unreadOnly) clauses.push('isRead eq false')
    if (sender.includes('@')) clauses.push("from/emailAddress/address eq '" + sender.replaceAll("'", "''") + "'")
    const params = new URLSearchParams({ '$orderby': 'receivedDateTime desc', '$filter': clauses.join(' and '),
      '$top': String(budget), '$select': fields + ',isRead' + (query ? ',body' : '') })
    const filterRow = row => {
      if (!matches(row) || input.unreadOnly && row.isRead !== false) return false
      if (!words.length) return true
      const content = normalized([row.subject, row.bodyPreview, textOf(row.body)].join(' '))
      return words.every(word => content.includes(normalized(word)))
    }
    ;({ rows, partial } = await collection(client, params, filterRow, endpoint))
  } else if (order === 'latest' && (query || subject || (sender && !sender.includes('@')))) {
    const queryString = [...words.map(x => JSON.stringify(x)), ...filters].join(' AND ')
    rows = []
    let more = true
    for (let offset = 0; more && rows.length < 10 && offset < budget; offset += 10) {
      const result = await client.request('/v1.0/search/query', { method: 'POST', body: JSON.stringify({ requests: [{
        entityTypes: ['message'], query: { queryString }, from: offset, size: 10, enableTopResults: false, fields: fields.split(','),
      }] }) })
      const container = result.value?.[0]?.hitsContainers?.[0]
      if (!Array.isArray(container?.hits)) throw new DomainError(502, 'invalid_graph_page')
      rows.push(...container.hits.map(h => ({ ...h.resource, id: h.resource?.id || h.hitId })).filter(matches))
      more = container.moreResultsAvailable === true
      if (!container.hits.length && more) throw new DomainError(502, 'invalid_graph_page')
    }
    partial = more
  } else if (query || subject || (sender && !sender.includes('@'))) {
    const expressions = new Set([JSON.stringify(query), words.map(w => JSON.stringify(w)).join(' AND ')])
    if (!query) { expressions.clear(); expressions.add('') }
    const pages = await Promise.all([...expressions].map(expression => collection(client, new URLSearchParams({
      '$search': JSON.stringify([expression, ...filters].filter(Boolean).join(' AND ')), '$select': fields, '$top': String(budget),
    }), matches)))
    rows = pages.flatMap(page => page.rows)
    partial = pages.some(page => page.partial)
  } else {
    const params = new URLSearchParams({ '$orderby': 'receivedDateTime desc', '$select': fields, '$top': String(budget) })
    const clauses = []
    if (range.start || sender) clauses.push('receivedDateTime ge ' + (range.start || '0001-01-01T00:00:00Z'))
    if (range.end) clauses.push('receivedDateTime lt ' + range.end)
    if (sender) clauses.push("from/emailAddress/address eq '" + sender.replaceAll("'", "''") + "'")
    if (clauses.length) params.set('$filter', clauses.join(' and '))
    ;({ rows, partial } = await collection(client, params, matches))
  }
  const items = [...new Map(rows.map(r => [r.id, message(r)])).values()]
  const phrase = normalized(subject || query)
  // Match numbered references as whole identifiers even when the user also supplies a topic.
  const identifiers = Array.from(query.matchAll(/\b[a-z]+[-_/]?\d+[a-z0-9]*(?:[-_/][a-z0-9]+)*\b/gi), match => normalized(match[0]))
  const contains = (text, words) => words && (' ' + text + ' ').includes(' ' + words + ' ')
  const tier = item => {
    if (!phrase || order === 'latest') return 0
    const title = normalized(item.subject)
    const preview = normalized(item.excerpt)
    if (contains(title, phrase) || identifiers.some(identifier => contains(title, identifier) || contains(preview, identifier))) return 2
    return contains(preview, phrase) ? 1 : 0
  }
  items.sort((a,b) => tier(b) - tier(a) || recentFirst(a,b))
  return { items: items.slice(0,10), partial: partial || items.length > 10,
    range: { from: range.from, to: range.to, timeZone: range.timeZone } }
}
/** Fetch the referenced result as plain text without changing read status. */
export async function readOutlook(lease, id, options = {}) {
  if (typeof id !== 'string' || !id || id.length > 1024 || id === '.' || id === '..') invalid()
  const client = createGraphClient(lease, options)
  const row = await client.request('/v1.0/me/messages/' + encodeURIComponent(id) + '?' +
    new URLSearchParams({ '$select': fields + ',body' }), { headers: { prefer: 'outlook.body-content-type="text"' } })
  if (row.id !== id) throw new DomainError(502, 'invalid_graph_message')
  return { ...message(row), text: textOf(row.body).slice(0, 12000) }
}
