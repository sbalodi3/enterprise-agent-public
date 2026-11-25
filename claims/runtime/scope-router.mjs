import { actionIntent } from './action-intent.mjs'
import { randomUUID } from 'node:crypto'
import { DomainError } from '../domain/index.mjs'
import { normalizeChatScope, selectedDocumentIds } from '../domain/chat.mjs'
import { parsePortfolioQuery, resolvePortfolioQuery } from './portfolio-query.mjs'
import { parseWorkQuery } from './work-query.mjs'
import { inboxSource, outlookIntent } from '../ui/outlook-chat.mjs'

const workspace = { kind: 'workspace' }
const portfolio = { kind: 'portfolio' }
const words = text => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const contains = (text, name) => !!name && (' ' + words(text) + ' ').includes(' ' + words(name) + ' ')
const questionAboutClaims = /\b(claims?|case(?:load|s)?|adjuster|incident|payroll|wage|handovers?|portfolio|work comp|(?:WC|CLM)-\d+)\b/i
const documentTerms = /\b(documents?|reports?|statements?|notes?|releases?|transcripts?|letters?|diary|handover|evidence)\b/i
const specificSource = /\b(document|report|statement|note|release|transcript|letter|memo|diary|handover)\b/i
const positive = /^(?:(?:please|can (?:you|we)|could (?:you|we)|would you|let.s)\s+)*(?:go over|open|compare|show|read|summari[sz]e|explain|review|check|inspect|pull|look|bring|add|investigate|tell|use|list|give|what|which|why|when|how|is|does|did|help|walk|find)\b/i
const uncertain = /["“”‘’`]|(?:^|\s)'[^']+'|\b(?:not|never|without|exclude|except|avoid|suppose|pretend|imagine|hypothetical|examples?|samples?|quot(?:e[ds]?|ing)|mention(?:s|ed|ing)?|referenc(?:e[sd]?|ing)|maybe|unless|if|either|or|instead|other (?:one|case|file|claim|report|document)|someone said|ignore|skip|unrelated)\b|\bn['’]t\b|n['’]t\b/i
const workspaceReference = /(?:[\/\\](?:WC|CLM)-\d|\b(?:WC|CLM)-\d+(?:-[\w-]+)?\.\w+|\b(?:repo(?:sitory)?|readme|regex|tests?|fixtures?|source code|identifiers?|filenames?|example code|(?:sub)?strings?|placeholders?|syntax|spelling|commits?|changelog)\b|\b[\w-]+\.(?:md|txt|tsx?|jsx?|json|py|csv|pdf|sql|log|ya?ml)\b)/i
const fileAction = /\b(?:write|save|export|copy|append|send|run|execute|upload|email)\b[^.!?\n]{0,100}\b(?:files?|workspace|shell|script|command|terminal|disk|folder|email|desktop|spreadsheet|csv|directory|[\w-]+\.(?:md|txt|csv|pdf|xlsx|json))\b/i
const portfolioTerms = /\b(my|assigned|our)\b.{0,40}\b(claims|cases|caseload|portfolio|queue|shift)\b|\b(portfolio|caseload)\b/i
const portfolioListing = /\ball (?:the )?(?:(?:open|active|closed|paid|denied) )?(?:claims|cases)\b|\b(?:claims|cases) (?:across|for all) (?:all )?adjusters\b/i
const portfolioMeasure = /\b(?:total billings|litigated count|by (?:line of business|business line|source status|adjuster))\b/i
const personalOpenCases = /\b(?:open|active) (?:claims?|cases?)\b.*\b(?:assigned to me|do i have|mine)\b/i
const intents = new Set(['claim', 'document', 'portfolio', 'workspace', 'clarify'])
const corrections = new Map()
const targetTerms = /\b(?:(?:WC|CLM)-\d+(?:-[\w-]+)?|filed-IN-\d+-[\w-]+|wage-[a-f0-9]{8}-[a-f0-9-]{27,36})\b/gi
const lookupStop = new Set(('a about account add an and any are as asked at be brief by can case cases check claim claims compare could describe did do does explain file find for from get give go had have help how i in including incident information insured into involving is it its list look me my of on one open or other our over please policy provide pull read record regarding review s say says select selected show specific status summarize summary take tell that the their then this through to up walk was we were what when where which who with would you').split(' '))
const targetWords = text => [...new Set(words(text).split(' ').filter(term => term.length > 1 && !lookupStop.has(term)))]
function namedBeforeClaim(text) {
  const before = /\b([\p{L}\p{N}-]+)\s+(?:claim|case)\b/giu
  return [...text.matchAll(before)].some(match => targetWords(match[1]).length && !/^(?:pinned|attached|current|existing|active|closed|another|same|previous|whole|entire|full)$/i.test(match[1]))
}
const claimOperation = Object.freeze({ kind: 'claim' })
const needsTarget = () => ({ question: { kind: 'clarification', text: 'Which claim or document do you mean? Enter a claim number, title, or identifying detail.', options: [], allowOther: true } })
const recordScope = scope => !!scope?.claimIds?.length

// Managed chat preflights only the source. Protected routes resolve targets independently
// with employee-owned state. File names or explanatory examples cannot attach a claim.
export async function preflightClaims({ question, scope = workspace, previous }, classify = infer) {
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) throw new DomainError(400, 'invalid_route')
  const claimWords = questionAboutClaims.test(question) || documentTerms.test(question)
  const selected = scope.kind !== 'workspace'
  if (fileAction.test(question) && (selected || claimWords)) return { action: 'clarify', mixed: true }
  if (workspaceReference.test(question)) return selected || claimWords
    ? {action:'clarify',mixed:true} : { action: 'workspace', mixed: false }
  if (actionIntent(question) && (selected || /\bclaim|\bdiary|\bcallback|\bwage/i.test(question))) return { action:'claims',mixed:false }
  if (inboxSource(question) || outlookIntent(question,{previous:previous?.kind === 'outlook'}) === 'mail' ||
      parseWorkQuery(question) || parsePortfolioQuery(question, previous) || selected || claimWords)
    return { action: 'claims', mixed: false }
  const prediction = await classify(question)
  return { action: prediction && ['claim','portfolio','document'].includes(prediction.intent) &&
    prediction.confidence >= .62 && prediction.margin >= .24 ? 'claims' : 'workspace', mixed: false }
}

function requestedScope(candidate, current, pins) {
  const { claimId, documentId } = candidate
  const subset = selectedDocumentIds(pins, claimId) || selectedDocumentIds(current, claimId)
  if (documentId && subset && !subset.includes(documentId)) return null
  const docs = documentId ? [documentId] : subset
  return normalizeChatScope({kind:'claim',claimIds:[claimId], ...(docs && {documents:{[claimId]:docs}})})
}

function candidateQuestion(row) {
  const { claimId, claimVersion, documentId, documentVersion, title, detail } = row
  const target = [...new Set([claimId, ...title.slice(0,240).split(' · '), documentId, detail?.slice(0,220)].filter(Boolean))].join(' · ')
  return { question: { kind: 'candidate', text: `Did you mean ${target}?`,
    options: [{id:'yes',label:'Yes'}, {id:'no',label:'No'}], allowOther: true,
    candidate: {claimId, claimVersion, title, ...(documentId && {documentId, documentVersion})} } }
}

/** Resolve a protected request against current employee access. Only the accepted scope reaches the answer agent. */
export function planClaimRequest(options) {
  if (!options.trace) return resolveClaimRequest(options)
  return options.trace.run('routing.decision', async (_traceId,_spanId,_link,annotate) => {
    const result = await resolveClaimRequest(options)
    annotate?.({'routing.action':result.question ? 'clarify' : 'claims',
      'routing.intent':result.question ? 'clarify' : result.scope?.claimIds ? 'claim' : result.operation?.kind === 'portfolio' ? 'portfolio' : 'unavailable',
      'routing.additions':result.focus?.claimIds?.length ?? 0})
    return result
  })
}

async function resolveClaimRequest({ domain, ctx, question, pins, focus, previous, correction, chooseCandidate,
  excludedClaimIds = [], excludedDocumentIds = [], clarifications = [], outlookConnected = false, describeTarget, describePortfolio, signal }) {
  pins = normalizeChatScope(pins || workspace)
  const current = normalizeChatScope(focus || pins)
  const answer = (scope, setFocus = false) => ({ scope, operation: claimOperation, ...(setFocus && {focus:scope}) })
  if (chooseCandidate) {
    const next = requestedScope(chooseCandidate, current, pins)
    if (!next || excludedClaimIds.includes(chooseCandidate.claimId) || excludedDocumentIds.includes(chooseCandidate.documentId)) return needsTarget()
    await domain.assertChatScope(ctx, next, [chooseCandidate])
    return {...answer(next,true), dependencies:[chooseCandidate]}
  }
  const intent = actionIntent(question)
  if (intent && !correction) {
    const command = question.split(/\bnotes?\s*:/i)[0].replace(/["“][^"”]*["”]/g, '')
    const ids = [...new Set((command.match(/\b(?:WC-\d{3}|CLM-\d{6})\b/gi) || []).map(s => s.toUpperCase()))]
    if (ids.length === 1) {
      if (excludedClaimIds.includes(ids[0])) return needsTarget()
      const target = requestedScope({claimId:ids[0]},current,pins)
      await domain.assertChatScope(ctx,target)
      return answer(target,true)
    }
    if (!ids.length && current.kind==='claim') return answer(current)
    if (ids.length>1 || current.kind==='multi' || intent!=='status')return needsTarget()
  }
  const source = inboxSource(question)
  const lastSource = clarifications.findLast(item => item.question?.kind === 'source')
  const chosen = lastSource?.answer?.selected
  const sourceChoice = String((Array.isArray(chosen) ? chosen[0] : chosen) || lastSource?.answer?.custom || correction || '').toLowerCase()
  const work = parseWorkQuery(question)
  if (source === 'outlook' || source === 'ambiguous' && sourceChoice.includes('outlook') ||
      !source && outlookIntent(question,{previous:previous?.kind === 'outlook'}) === 'mail') return {scope:portfolio,operation:{kind:'outlook'}}
  if (source === 'ambiguous' && outlookConnected && !sourceChoice.includes('workbench')) return { question: {
    kind:'source', text:'Which inbox do you want to search?', options:[{id:'workbench',label:'Workbench Inbox'},{id:'outlook',label:'Outlook Mail'}], allowOther:true,
  }}
  if (work || source) return { scope:portfolio, operation: work || {kind:'workbench',operation:/\bunread\b/i.test(question) ? 'unread' : 'inbox'} }
  const lastQuestion = clarifications.at(-1)
  const portfolioText = lastQuestion?.question?.kind === 'portfolio' ? lastQuestion.answer.custom ||
    lastQuestion.question.options.find(option=>option.id===lastQuestion.answer.selected?.[0])?.label || question : question
  const portfolioPlan = correction && lastQuestion?.question?.kind !== 'portfolio' ? null :
    await resolvePortfolioQuery(portfolioText,previous,describePortfolio,signal)
  if (portfolioPlan) return portfolioPlan
  const text = (correction || question).trim()
  const references = [...new Set((text.match(targetTerms) || []).map(id => id.toLowerCase()))]
  const safeText = text.replace(/(\p{L})['’]s\b/gu, '$1s')
  if (workspaceReference.test(text) || fileAction.test(text) ||
      (references.length || specificSource.test(text)) && uncertain.test(safeText)) return needsTarget()
  if (!references.length && !correction && portfolioMeasure.test(text) && questionAboutClaims.test(text))
    return {scope:portfolio,operation:{kind:'portfolio_read'}}
  if (!references.length && !correction) {
    if (/\b(?:pinned|attached|manually selected) (?:claims?|documents?|files?|reports?)\b/i.test(text) && recordScope(pins)) return answer(pins)
    if (/\b(?:this|that|current|selected) (?:claim|case|document|file|report)\b/i.test(text) && recordScope(current)) return answer(current)
  }
  const sourceQuery = specificSource.test(text) && !/\b(?:this|that|selected|attached|pinned) (?:document|report|source|note)\b/i.test(text)
  const lookup = /\b(?:open|find|pull up|look up|switch to|go over|attach|add)\b/i.test(text) && targetWords(text).length &&
    !/\b(?:it|this|that|its|their|the timeline)\b/i.test(text)
  const hasNewTarget = references.length || correction || lookup || namedBeforeClaim(text) || /\b(?:claim|case|file|document|policy) (?:about|for|involving|named|called|on|with|of)\b|\b(?:open|find|read|pull up|look up|attach|switch to|add|review)\b.{1,80}\b(?:claim|case|report|note|handover|document)\b/i.test(text) || sourceQuery
  if (!hasNewTarget && /\b(?:pinned|attached)\b/i.test(text) && recordScope(pins)) return answer(pins)
  if (!hasNewTarget && recordScope(current)) return answer(current)
  if (!hasNewTarget && current.kind === 'portfolio' && !correction) return {scope:portfolio, operation:{kind:'portfolio_read'}}
  if (!references.length && !documentTerms.test(text) && (portfolioTerms.test(text) || portfolioMeasure.test(text) || portfolioListing.test(text)))
    return {scope:portfolio, operation:{kind:'portfolio_read'}}
  if (uncertain.test(safeText)) return needsTarget()
  const claimRefs = references.filter(id => /^(?:wc|clm)-\d+$/.test(id))
  const docRefs = references.filter(id => !claimRefs.includes(id))
  // A claim ID identifies the parent for a document search; it never substitutes for a missing document.
  const documents = !!docRefs.length || sourceQuery
  let terms = targetWords(text)
  const parents = documents ? claimRefs.map(id => id.toUpperCase()) : []
  const subsets = Object.fromEntries([...new Set([...(pins.claimIds || []), ...(current.claimIds || [])])]
    .flatMap(id => { const subset = selectedDocumentIds(pins,id) || selectedDocumentIds(current,id); return subset ? [[id,subset]] : [] }))
  const search = async queryTerms => domain.chatTargetCandidates(ctx, {text:words(text),terms:queryTerms,
    documents,references: documents ? docRefs : claimRefs,parents,excludedClaimIds,excludedDocumentIds,subsets})
  let rows = await search(terms)
  signal?.throwIfAborted()
  let inferred = false
  if (!rows.length && !references.length && describeTarget) {
    const suggested = await describeTarget(text,signal)
    if (suggested?.length) {
      terms = suggested
      rows = await search(terms)
      inferred = true
    }
  }
  const exact = rows.filter(row => row.exactId)
  const explicit = documents ? docRefs : claimRefs
  if (explicit.length && exact.length !== explicit.length) return needsTarget()
  const best = exact.length ? exact : rows.filter(row => row.exactTitle || (terms.length && row.matches === terms.length))
  const compound = /\b(?:compare|contrast|alongside|versus|vs|and (?:the |that |another )?[\w -]{0,65}(?:claim|case|report|note|document))\b/i.test(text)
  if (compound && unaccountedTarget(text, [...references,...best.map(row=>row.title)])) return needsTarget()
  if (!rows.length) return needsTarget()
  const namedSet = compound && best.length > 1 && best.every(r=>r.exactTitle) && new Set(best.map(r=>words(r.title))).size === best.length
  if (!explicit.length && !namedSet && (best.length !== 1 || inferred || excludedClaimIds.length || excludedDocumentIds.length))
    return candidateQuestion(best[0] || rows[0])
  const matched = explicit.length ? exact : best
  if (matched.length > 12) return needsTarget()
  let next = /^\s*(?:please\s+)?add\b/i.test(text) ? current : workspace
  for (const row of matched) {
    const target = requestedScope(row, current, pins)
    if (!target) return needsTarget()
    const docs = selectedDocumentIds(target, row.claimId) || []
    next = selection(next, [row.claimId], docs.map(documentId => ({claimId:row.claimId,documentId})))
    if (!next) return needsTarget()
  }
  await domain.assertChatScope(ctx, next, matched)
  return {...answer(next,true),dependencies:matched.map(({claimId,claimVersion,documentId,documentVersion}) =>
    ({claimId,claimVersion,...(documentId && {documentId,documentVersion})}))}
}

async function infer(text) {
  if (!process.env.CLAIMS_ROUTER_URL) return null
  try {
    const response = await fetch(new URL('/classify', process.env.CLAIMS_ROUTER_URL), {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) { await response.body?.cancel(); return null }
    const result = await response.json()
    if (intents.has(result.intent) && /^scope-minilm-[0-9a-f]{12}$/.test(result.version) &&
        Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1 &&
        Number.isFinite(result.margin) && result.margin >= 0 && result.margin <= 1) return result
  } catch { /* Offline use keeps manual scope selection available. */ }
  return null
}

function validList(value) {
  return value === undefined || (Array.isArray(value) && value.length <= 512 &&
    value.every(id => typeof id === 'string' && /^[\w:.-]{1,128}$/.test(id)))
}

async function catalog(domain, ctx) {
  const rows = new Map()
  let total
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await domain.chatSearch(ctx, { status: 'all', offset, limit: 50 })
    if (page.total > 500 || total !== undefined && page.total !== total) return null
    total = page.total
    for (const row of page.items) {
      if (rows.has(row.id)) return null
      rows.set(row.id, row)
    }
    if (rows.size === total) return [...rows.values()]
    if (page.items.length < 50) break
  }
  return null // Do not resolve a purportedly unique title from a changing or incomplete catalog.
}

function selection(scope, claimIds, selectedDocs) {
  const ids = [...new Set([...(scope.claimIds || []), ...claimIds])].sort()
  if (ids.length > 12) return null
  const documents = {}
  for (const id of ids) {
    const already = scope.claimIds?.includes(id)
    const previous = selectedDocumentIds(scope, id)
    const requested = selectedDocs.filter(d => d.claimId === id).map(d => d.documentId)
    if (previous || (!already && requested.length)) documents[id] = [...new Set([...(previous || []), ...requested])].sort()
  }
  return normalizeChatScope({ kind: ids.length > 1 ? 'multi' : 'claim', claimIds: ids, documents })
}

// Every target in a compound request must resolve. A recognized first record cannot authorize
// reading it as a substitute for a second, unrecognized record.
function unaccountedTarget(question, matches) {
  let rest = ' ' + words(question) + ' '
  for (const name of [...new Set(matches.map(words))].sort((a,b) => b.length-a.length))
    rest = rest.replaceAll(' ' + name + ' ', ' selectedrecord ')
  if (specificSource.test(rest.replace(/\b(?:claim|case) (?:file|record)\b/g, ' '))) return true
  const comparing = /\b(?:compare|comparison|contrast)\b/i.test(question)
  const separator = comparing ? /\b(?:and|with|versus|vs|alongside|against|to)\b/ : /\b(?:and|with|versus|vs|alongside|against)\b/
  const clauses = rest.trim().split(separator)
  if (clauses.length > 1 && !clauses[0].includes('selectedrecord') &&
      (comparing || /\b(?:claim|case|file|record)\b/.test(clauses[0]))) return true
  return clauses.slice(1).some(clause => {
    const target = clause.trim()
    return target && !target.includes('selectedrecord') && !/^(?:explain|summari[sz]e|tell|highlight|identify|show|see|check|look|list|confirm|when|how|why|what)\b/.test(target)
  })
}

export async function decideScope({ domain, ctx, input, classify = infer }) {
  if (!input || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 4000 ||
      !validList(input.excludedClaimIds) || !validList(input.excludedDocumentIds)) throw new DomainError(400, 'invalid_route')
  const question = input.question.trim()
  const scope = normalizeChatScope(input.scope ?? workspace)
  if (scope.kind !== 'workspace') await domain.assertChatScope(ctx, scope)
  const references = [...new Set((question.match(/\b(?:(?:WC|CLM)-\d+(?:-[\w-]+)?|filed-IN-\d+-[\w-]+|wage-[a-f0-9]{8}-[a-f0-9-]{27,36})\b/gi) || []).map(s => s.toLowerCase()))]
  const claimsLanguage = questionAboutClaims.test(question)
  const mixed = fileAction.test(question) && (scope.kind !== 'workspace' || references.length > 0 || claimsLanguage)
  const prediction = await classify(question)
  const confident = prediction && prediction.confidence >= 0.62 && prediction.margin >= 0.24
  const decision = (action, next, reason, added = []) => ({ action, scope: next, reason, added,
    mixed: !!mixed,
    intent: prediction?.intent ?? 'unavailable', version: prediction?.version ?? 'offline',
    confidenceBand: confident ? 'high' : prediction ? 'low' : 'unavailable' })
  const clarify = () => decision('clarify', scope, 'choose_scope')
  if (mixed) return decision('clarify', scope, 'mixed_request')
  if (workspaceReference.test(question)) {
    return references.length || claimsLanguage || scope.kind !== 'workspace' ? clarify() : decision('workspace', scope, 'workspace')
  }
  const withoutPossessives = question.replace(/(\p{L})['’]s\b/gu, '$1s')
  if (uncertain.test(withoutPossessives) && (references.length || claimsLanguage || scope.kind !== 'workspace' || prediction?.intent === 'document')) return clarify()
  if ((portfolioTerms.test(question) || personalOpenCases.test(question) || portfolioListing.test(question) ||
      (claimsLanguage && portfolioMeasure.test(question))) && !references.length && positive.test(question)) {
    if (scope.kind !== 'workspace' && scope.kind !== 'portfolio') return clarify()
    return decision('claims', portfolio, 'portfolio_summary')
  }
  if (!references.length && !claimsLanguage && !documentTerms.test(question) && scope.kind === 'workspace' &&
      (!confident || prediction.intent === 'workspace')) return decision('workspace', scope, 'workspace')
  if (!positive.test(question) && !/^CLM-\d{6}$/i.test(question)) {
    if (references.length || scope.kind === 'workspace' && (claimsLanguage || documentTerms.test(question))) return clarify()
    return decision(scope.kind === 'workspace' ? 'workspace' : 'claims', scope, 'current_scope')
  }
  if (!references.length && scope.kind === 'workspace' && (!confident || !['claim','document'].includes(prediction.intent))) {
    return !claimsLanguage && prediction?.intent === 'workspace' ? decision('workspace', scope, 'workspace') : clarify()
  }
  const rows = await catalog(domain, ctx)
  if (!rows) return clarify()
  const ids = []
  const names = [...references]
  const exactDocs = []
  for (const ref of references) {
    const parent = /^(?:wc|clm)-\d+/.exec(ref)?.[0]
    if (!parent) { exactDocs.push(ref); continue }
    const match = rows.find(row => row.id.toLowerCase() === parent)
    if (!match) return clarify()
    ids.push(match.id)
    if (ref !== parent) exactDocs.push(ref)
  }
  // Explicit claim IDs disambiguate titles. A duplicate title alone stays a picker decision.
  const namedRows = ids.length ? rows.filter(row => ids.includes(row.id)) : rows
  const titles = namedRows.filter(row => contains(question, row.title))
  for (const row of titles) {
    if (!ids.includes(row.id) && titles.some(other => other.id !== row.id && words(other.title) === words(row.title))) return clarify()
    names.push(row.title)
    if (!ids.includes(row.id)) ids.push(row.id)
  }
  const selectedDocs = []
  if (exactDocs.length || documentTerms.test(question) || confident && prediction.intent === 'document') {
    // Only metadata travels here; evidence text enters a protected turn after authorization.
    const parents = ids.length ? [...new Set(ids)] : scope.claimIds?.length ? scope.claimIds : rows.map(row => row.id)
    const matches = []
    for (const parent of parents) {
      const list = await domain.chatDocuments(ctx, parent)
      for (const doc of list.items) {
        if (exactDocs.includes(doc.id.toLowerCase()) || contains(question, doc.title))
          matches.push({ claimId: parent, documentId: doc.id, title: doc.title })
      }
    }
    if (exactDocs.some(ref => !matches.some(d => d.documentId.toLowerCase() === ref))) return clarify()
    if (matches.some(d => !exactDocs.includes(d.documentId.toLowerCase()) && matches.filter(m => words(m.title) === words(d.title)).length > 1)) return clarify()
    if (!matches.length && !ids.length && (scope.kind === 'workspace' ||
        specificSource.test(question) && !/\b(?:this|that|selected|attached) (?:document|report|statement|note|source)\b/i.test(question))) return clarify()
    for (const doc of matches) {
      const subset = selectedDocumentIds(scope, doc.claimId)
      if ((subset && !subset.includes(doc.documentId)) || input.excludedDocumentIds?.includes(doc.documentId)) return clarify()
      names.push(doc.title, doc.documentId)
      selectedDocs.push({ claimId: doc.claimId, documentId: doc.documentId })
      ids.push(doc.claimId)
    }
  }
  if (!ids.length) {
    if (scope.kind === 'workspace') return clarify()
    return decision('claims', scope, 'current_scope')
  }
  if (unaccountedTarget(question, names) || ids.some(id => input.excludedClaimIds?.includes(id))) return clarify()
  if (ids.every(id => scope.claimIds?.includes(id))) return decision('claims', scope, 'current_scope')
  const next = selection(scope, ids, selectedDocs)
  if (!next) return clarify()
  if (input.excludedDocumentIds?.length) {
    // Undoing an individual source also rules out silently putting it back through its parent.
    for (const id of next.claimIds.filter(id => !scope.claimIds?.includes(id) && !selectedDocumentIds(next, id))) {
      const { items } = await domain.chatDocuments(ctx, id)
      if (items.some(doc => input.excludedDocumentIds.includes(doc.id))) return clarify()
    }
  }
  await domain.assertChatScope(ctx, next)
  const added = next.claimIds.filter(id => !scope.claimIds?.includes(id)).flatMap(claimId => {
    const docs = selectedDocs.filter(doc => doc.claimId === claimId)
    return docs.length ? docs : [{ claimId }]
  })
  return decision('claims', next, added.length ? 'attached' : 'current_scope', added)
}

export async function routeClaimsPrompt({ domain, ctx, input, trace }) {
  if (input?.preflight === true) return trace.run('routing.decision', async (_traceId,_spanId,_link,annotate) => {
    const result = await preflightClaims(input)
    annotate?.({'routing.action':result.action})
    return result
  })
  const actor = JSON.stringify([ctx.tenantId, ctx.profileId, ctx.principalId, ctx.subject])
  if (input?.undo) {
    const saved = corrections.get(input.undo)
    if (saved?.actor === actor && saved.expires > Date.now()) {
      corrections.delete(input.undo)
      await trace.run('routing.undo', () => {}, saved.link)
    }
    return { recorded: true }
  }
  return trace.run('routing.decision', async (traceId, spanId, link, annotate) => {
    const result = await decideScope({ domain, ctx, input })
    annotate?.({ 'routing.intent': result.intent, 'routing.model': result.version, 'routing.confidence': result.confidenceBand,
      'routing.action': result.action, 'routing.additions': result.added.length })
    if (result.added.length) {
      for (const [id, value] of corrections) {
        if (value.expires > Date.now() && corrections.size < 1024) break
        corrections.delete(id)
      }
      result.routingId = randomUUID()
      corrections.set(result.routingId, { actor, link: { traceId, spanId }, expires: Date.now() + 10 * 60_000 })
    }
    return result
  }, ctx)
}
