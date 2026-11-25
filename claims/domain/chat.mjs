import { activeDataset, claimLines, claimSourceStatuses } from './claim-access.mjs'
import { directory } from '../auth/roster.mjs'
// Protected conversations are independent of workspace sessions and their owner-level history APIs.
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { candidateScope, checkedQuestion, checkedReply, continuation, publicQuestion } from './turn-questions.mjs'
import { caseRows, caseViews } from './case-views.mjs'
import { searchChatTargets } from './target-search.mjs'
import { DomainError } from './index.mjs'

const fail = (status, code) => { throw new DomainError(status, code) }
const identifier = (id) => typeof id === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(id)
const positive = (version) => Number.isSafeInteger(version) && version > 0

function businessLines(lob, lobs, error) {
  if (typeof lob !== 'string' || (lob && !claimLines.includes(lob))) fail(400, error)
  if (lobs === undefined) return lob ? [lob] : []
  if (lob || !Array.isArray(lobs) || !lobs.length || lobs.length > claimLines.length ||
      new Set(lobs).size !== lobs.length || !lobs.every(value => claimLines.includes(value))) fail(400, error)
  return lobs
}

// A missing per-claim entry means the entire claim. An empty document list must never widen the scope.
export function selectedDocumentIds(scope, claimId) {
  if (scope.kind === 'document') return scope.claimIds.includes(claimId) ? [scope.documentId] : undefined
  return Object.hasOwn(scope.documents ?? {}, claimId) ? scope.documents[claimId] : undefined
}

export function normalizeChatScope(raw) {
  const invalid = () => fail(400, 'invalid_chat_scope')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !['kind', 'claimIds', 'documentId', 'documents'].includes(key))) invalid()
  const { kind, documentId, documents, claimIds = [] } = raw
  if (!Array.isArray(claimIds) || !claimIds.every(identifier) || new Set(claimIds).size !== claimIds.length) invalid()
  if (kind === 'portfolio' || kind === 'workspace') {
    if (claimIds.length || documentId !== undefined || documents !== undefined) invalid()
    return { kind }
  }
  if (kind === 'document' && claimIds.length === 1 && identifier(documentId) && documents === undefined)
    return { kind, claimIds, documentId }
  if (documentId !== undefined || !(kind === 'claim' && claimIds.length === 1 ||
    kind === 'multi' && claimIds.length >= 2 && claimIds.length <= 12)) invalid()
  const scope = { kind, claimIds: [...claimIds].sort() }
  if (documents !== undefined) {
    if (!documents || typeof documents !== 'object' || Array.isArray(documents)) invalid()
    const entries = Object.entries(documents).sort(([a], [b]) => a.localeCompare(b))
    if (entries.length) scope.documents = Object.fromEntries(entries.map(([id, docs]) => {
      if (!claimIds.includes(id) || !Array.isArray(docs) || !docs.length || docs.length > 128 ||
          !docs.every(identifier) || new Set(docs).size !== docs.length) invalid()
      return [id, [...docs].sort()]
    }))
  }
  return scope
}

// This set stays server-side. An aggregate depends on all matching rows, including later pages.
function mergeDependencies(...groups) {
  const result = new Map()
  for (const group of groups) for (const dep of group) {
    if (!dep || !identifier(dep.claimId) || !positive(dep.claimVersion) ||
      (dep.documentId !== undefined && (!identifier(dep.documentId) || !positive(dep.documentVersion))))
      fail(400, 'invalid_dependency')
    const key = JSON.stringify([dep.claimId, dep.documentId])
    const prev = result.get(key)
    if (prev && (prev.claimVersion !== dep.claimVersion || prev.documentVersion !== dep.documentVersion))
      fail(409, 'stale_version')
    result.set(key, { claimId: dep.claimId, claimVersion: dep.claimVersion,
      ...(dep.documentId && { documentId: dep.documentId, documentVersion: dep.documentVersion }) })
  }
  return [...result.values()]
}

function checkMembership(scope, dependencies) {
  for (const dep of dependencies) {
    if (scope.kind !== 'portfolio' && !scope.claimIds?.includes(dep.claimId)) fail(404, 'not_found')
    if (scope.kind === 'portfolio' && dep.documentId) fail(404, 'not_found')
    const docs = selectedDocumentIds(scope, dep.claimId)
    if (docs && dep.documentId && !docs.includes(dep.documentId)) fail(404, 'not_found')
  }
}

const owners = (u) => [u.tenant, u.profile, u.id, u.subject]
const iso = (value) => new Date(value).toISOString()
const header = (r) => ({ id: r.id, scope: r.scope, scopeRevision: r.scope_revision, updatedAt: iso(r.updated_at) })
const unavailable = (e) => e instanceof DomainError && (e.status === 404 || e.code === 'stale_version')

// Chat picks only records assigned to or explicitly shared with the employee.
const associated = `${activeDataset} AND i.tenant=$1 AND i.profile=$2 AND i.type='claim' AND
  (i.owner_id=$3 OR EXISTS(SELECT 1 FROM cw_principals p WHERE p.tenant=$1 AND p.profile=$2 AND p.id=$3 AND p.role='claims_admin') OR EXISTS(SELECT 1 FROM cw_readers r WHERE r.item_id=i.id AND r.principal_id=$3))`
const principalScope = (u) => [u.tenant, u.profile, u.id]

export function chatConversations({ run, rank, asOf, connected, readWorkQuery }) {
  const evidenceTable = connected ? 'cw_evidence' : 'cw_chat_note_documents'
  async function revisions(db, u, scopes, dependencies, lock = false) {
    const claimIds = [...new Set([...scopes.flatMap(s => s.claimIds ?? []), ...dependencies.map(d => d.claimId)])].sort()
    const docIds = [...new Set([...scopes.flatMap(s => (s.claimIds ?? []).flatMap(id => selectedDocumentIds(s, id) ?? [])), ...dependencies.map(d => d.documentId)].filter(Boolean))].sort()
    const versions = new Map(), documents = new Map()
    // One projection per history read. Ordered commit-time locks serialize a finished answer with transfer.
    if (claimIds.length) {
      const items = await db.query(
        `SELECT i.id,i.version FROM cw_items i WHERE ${associated} AND i.id=ANY($4::text[])
         ORDER BY i.id ${lock ? 'FOR SHARE OF i' : ''}`, [...principalScope(u), claimIds],
      )
      for (const r of items.rows) versions.set(r.id, r.version)
    }
    if (docIds.length && versions.size) {
      const records = await db.query(
        `SELECT id,item_id,(document->>'version')::int AS version FROM ${evidenceTable}
         WHERE item_id=ANY($1::text[]) AND id=ANY($2::text[]) AND document IS NOT NULL ORDER BY id
         ${lock ? 'FOR SHARE' : ''}`, [[...versions.keys()], docIds],
      )
      for (const r of records.rows) documents.set(r.id, r)
    }
    return { versions, documents }
  }

  function validate(scope, dependencies, { versions, documents }) {
    checkMembership(scope, dependencies)
    const own = (scope.claimIds ?? []).map(claimId => {
      if (!versions.has(claimId)) fail(404, 'not_found')
      return { claimId, claimVersion: versions.get(claimId) }
    })
    // Check all contributors first, including documents whose owning claim might have changed.
    if (dependencies.some(dep => !versions.has(dep.claimId) ||
      (dep.documentId && documents.get(dep.documentId)?.item_id !== dep.claimId))) fail(404, 'not_found')
    for (const dep of dependencies) {
      if (versions.get(dep.claimId) !== dep.claimVersion) fail(409, 'stale_version')
      if (dep.documentId) {
        const d = documents.get(dep.documentId)
        if (d.version !== dep.documentVersion) fail(409, 'stale_version')
      }
    }
    for (const claimId of scope.claimIds ?? []) {
      for (const id of selectedDocumentIds(scope, claimId) ?? []) {
        const doc = documents.get(id)
        if (doc?.item_id !== claimId) fail(404, 'not_found')
        own.push({ claimId, claimVersion: versions.get(claimId), documentId: id, documentVersion: doc.version })
      }
    }
    return mergeDependencies(own, dependencies)
  }

  async function inspect(db, u, scope, dependencies = [], lock = false) {
    return validate(scope, dependencies, await revisions(db, u, [scope], dependencies, lock))
  }

  async function owned(db, u, id, lock = false) {
    const row = (await db.query(
      `SELECT * FROM cw_chat_conversations WHERE tenant=$1 AND profile=$2 AND actor=$3 AND subject=$4 AND id=$5
       ${lock ? 'FOR UPDATE' : ''}`, [...owners(u), id],
    )).rows[0]
    if (!row) fail(404, 'not_found')
    return row
  }

  async function rankedClaims(db, u, status, assignedOnly) {
    const rows = await db.query(`SELECT i.* FROM cw_items i WHERE ${associated}
      AND ($4='all' OR i.lifecycle=$4) AND (NOT $5::boolean OR i.owner_id=$3)`, [...principalScope(u), status, assignedOnly])
    return rank(rows.rows, asOf, connected)
  }

  function matchingClaims(ranked, { query = '', dueToday = false, waitingOnly = false }) {
    const end = new Date(asOf)
    end.setUTCHours(24, 0, 0, 0)
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const items = ranked.filter(i => {
      const searchable = [i.id, i.title, i.reason, i.nextAction,i.policyNumber,i.lob,i.sourceStatus].join(' ').toLowerCase()
      return (!waitingOnly || i.section === 'waiting') &&
        (!dueToday || (i.dueAt && i.dueAt >= asOf && i.dueAt < end.toISOString())) &&
        terms.every(term => searchable.includes(term))
    })
    if (dueToday) items.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id))

    return items
  }

  async function checkCandidate(db, u, candidate, lock = false) {
    if (candidate) await inspect(db, u, normalizeChatScope(candidateScope(candidate)), [candidate], lock)
  }

  async function checkWork(db, u, turn, cached) {
    if (turn.plan?.kind !== 'workbench' || !turn.answer?.work) return
    const key = JSON.stringify(turn.plan)
    const fresh = cached?.get(key) ?? await readWorkQuery(db, u, turn.plan)
    cached?.set(key, fresh)
    if (!isDeepStrictEqual(fresh.work, turn.answer.work)) fail(409, 'stale_version')
  }

  async function read(db, u, row, liveCards = false, effective = row.scope, omitId, plan, excludedPreviousTurnId) {
    const history = await db.query(
      'SELECT *,lease_until <= clock_timestamp() AS expired FROM cw_chat_turns WHERE conversation_id=$1 ORDER BY created_at,id', [row.id],
    )
    const candidates = history.rows.flatMap(t => [t.pending_question, ...t.replies.map(r => r.question)]
      .flatMap(question => question?.candidate ? [question.candidate] : []))
    const current = await revisions(db, u, [row.scope, effective, ...(row.focus ? [row.focus] : []), ...history.rows.map(t => t.scope)],
      [...history.rows.flatMap(t => t.dependencies), ...candidates])
    validate(row.scope, [], current)
    const selected = validate(effective, [], current)
    let focus
    if (row.focus) {
      try { validate(row.focus, [], current); focus = row.focus } catch (e) { if (!unavailable(e)) throw e }
    }
    const turns = [], completed = []
    let previousPlan, lastTurnId, beforeTarget = true
    // A history refresh uses one current, employee-owned cohort for all case cards.
    // Historical prompts, answers and inference dependencies keep their original version checks.
    const views = new Map(), workResults = new Map()
    let assigned, explorable
    for (const t of history.rows) {
      // A native workspace or mailbox result can interrupt protected history.
      // The browser can only exclude the immediately preceding turn, and a
      // stored interruption applies to every later retry and clarification.
      if (beforeTarget && lastTurnId && t.exclusions?.excludedPreviousTurnId === lastTurnId) {
        previousPlan = undefined
        completed.length = 0
      }
      if (t.id === omitId) beforeTarget = false
      if (beforeTarget) {
        lastTurnId = t.id
        if (t.scope_revision === row.scope_revision) previousPlan = undefined
      }
      const view = t.answer?.cases?.view
      let cases
      if (liveCards && t.state === 'completed' && t.scope.kind === 'portfolio' && Object.hasOwn(caseViews, view)) {
        if (!views.has(view)) {
          assigned ??= await rankedClaims(db, u, 'open', true)
          explorable ??= connected && (await db.query("SELECT 1 FROM cw_datasets WHERE id='cms-mcp' AND active")).rowCount > 0
          const items = matchingClaims(assigned, caseViews[view])
          views.set(view, caseRows({ items: items.slice(0, 12), total: items.length, asOf }, view, explorable))
        }
        cases = views.get(view)
      }
      try {
        validate(t.scope, t.dependencies, current)
        await checkWork(db, u, t, workResults)
        const candidate = t.pending_question?.candidate
        if (candidate) validate(candidateScope(candidate), [candidate], current)
      } catch (e) {
        if (!unavailable(e)) throw e
        if (t.state === 'awaiting_input') {
          // Keep cancellation available when a pending source disappears or is superseded.
          turns.push({ id: t.id, state: t.state, pendingQuestion: { id: t.pending_question.id, kind: 'unavailable',
            question: 'The supporting record changed. Cancel this question and try again.', options: [], allowOther: false } })
        } else turns.push({ id: t.id, state: e.status === 404 ? 'unavailable' : 'stale',
          ...(e.status===409 && t.answer?.actionContext && current.versions.has(t.answer.actionContext.claimId) && {actionClaim:t.answer.actionContext.claimId}), ...(cases && { cases }) })
        continue
      }
      const abandoned = t.state === 'running' && t.expired
      const summary = {
        id: t.id, requestId: t.request_id, scope: t.scope, state: abandoned ? 'failed' : t.state, question: t.question,
        activity: t.activity, createdAt: iso(t.created_at),
        ...(t.answer && { answer: t.answer }), ...(cases && { cases }), ...(t.plan && { plan: t.plan }),
        ...(t.pending_question && { pendingQuestion: publicQuestion(t.pending_question) }),
        ...(abandoned || t.error_code ? { error: abandoned ? 'turn_interrupted' : t.error_code } : {}),
      }
      const clarifications = []
      for (const reply of t.replies) {
        if (!reply.answer) continue
        const candidate = reply.question.candidate
        if (candidate) {
          try { validate(candidateScope(candidate), [candidate], current) }
          catch (e) { if (unavailable(e)) continue; throw e }
        }
        clarifications.push({ question: publicQuestion(reply.question), answer: reply.answer })
      }
      // Rejected suggestions and free-text corrections remain in the employee's
      // protected transcript. The answer model only reuses scope-eligible history.
      turns.push(clarifications.length ? { ...summary, clarifications } : summary)
      // User prompts can quote evidence absent from tool dependencies. Only reuse turns from the
      // same continuous scope revision, including when the user clears and later reselects a chip.
      if (!beforeTarget || t.state !== 'completed' || t.scope_revision !== row.scope_revision) continue
      previousPlan = t.answer?.portfolioQuery ?? t.plan
      if (['outlook','workbench'].includes(t.plan?.kind)) continue
      if (isDeepStrictEqual(t.scope, effective)) completed.push({ summary, dependencies: t.dependencies })
      else if (t.scope.kind !== 'portfolio' || effective.kind === 'portfolio') completed.length = 0
    }
    // Only the recent authorized dialogue is supplied to inference. Inherited dependency sets
    // include any older records that informed one of those particular saved answers.
    if (!omitId && lastTurnId && lastTurnId === excludedPreviousTurnId) {
      previousPlan = undefined
      completed.length = 0
    }
    const recent = ['outlook','workbench'].includes(plan?.kind) ? [] : completed.slice(-3)
    return {
      conversation: { ...header(row), ...(focus && { focus }), turns },
      previousPlan,
      modelHistory: recent.map(t => t.summary),
      dependencies: mergeDependencies(selected, ...recent.map(t => t.dependencies)),
    }
  }

  async function active(db, u, id, turnId, attemptId) {
    const row = await owned(db, u, id, true)
    const turn = (await db.query(
      `SELECT * FROM cw_chat_turns WHERE id=$1 AND conversation_id=$2 AND attempt_id=$3
       AND state='running' AND lease_until > clock_timestamp() FOR UPDATE`, [turnId, id, attemptId],
    )).rows[0]
    if (!turn) fail(409, 'turn_no_longer_active')
    return { row, turn }
  }
  function citation(input) {
    const { claimId, claimVersion, documentId, documentVersion, anchorId } = input ?? {}
    if (!identifier(anchorId) || !identifier(documentId) || !identifier(claimId) ||
      !positive(claimVersion) || !positive(documentVersion)) fail(400, 'invalid_citation')
    return { claimId, claimVersion, documentId, documentVersion, anchorId }
  }

  async function resolveDocument(db, u, ref) {
    const item = (await db.query(`SELECT i.version FROM cw_items i WHERE ${associated} AND i.id=$4`,
      [...principalScope(u), ref.claimId])).rows[0]
    if (!item) fail(404, 'not_found')
    if (item.version !== ref.claimVersion) fail(409, 'stale_version')
    const doc = (await db.query(
      `SELECT document - 'verification' AS document FROM ${evidenceTable} WHERE item_id=$1 AND id=$2`,
      [ref.claimId, ref.documentId],
    )).rows[0]?.document
    if (!doc) fail(404, 'not_found')
    if (doc.version !== ref.documentVersion) fail(409, 'stale_version')
    if (!doc.anchors.some(a => a.id === ref.anchorId)) fail(404, 'not_found')
    return doc
  }

  return {
    cmsEnabled(ctx) {
      return run(ctx, async db => (await db.query("SELECT 1 FROM cw_datasets WHERE id='cms-mcp' AND active")).rowCount > 0, true)
    },
    adjusters(ctx) {
      return run(ctx, async (db, u) => {
        const { rows } = await db.query(`SELECT id FROM cw_principals WHERE tenant=$1 AND profile=$2
          AND role IN ('adjuster','supervisor') ORDER BY id`, [u.tenant,u.profile])
        const enabled = (await db.query("SELECT 1 FROM cw_datasets WHERE id='cms-mcp' AND active")).rowCount > 0
        const names = new Map(directory(connected, enabled).employees.map(person => [person.principalId, person.displayName]))
        return { canFilterByOwner: u.role === 'claims_admin',
          items: rows.filter(r => names.has(r.id)).map(r => ({ id: r.id, displayName: names.get(r.id) })) }
      }, true)
    },
    portfolioSummary(ctx, { groupBy = 'lob', status = 'all', sourceStatus = '', lob = '', lobs, ownerId = '', assignedOnly = false } = {}) {
      const columns = { lob: 'i.line_of_business', status: 'i.source_claim_status', adjuster: 'i.owner_id' }
      const lines = businessLines(lob, lobs, 'invalid_summary')
      if (!Object.hasOwn(columns, groupBy) || !['open','all','closed'].includes(status) || (sourceStatus && !claimSourceStatuses.includes(sourceStatus)) ||
          typeof assignedOnly !== 'boolean') fail(400,'invalid_summary')
      return run(ctx, async (db, u) => {
        if (ownerId && ownerId !== u.id && u.role !== 'claims_admin') fail(403,'forbidden')
        const { rows } = await db.query(`SELECT ${columns[groupBy]} AS key, count(*)::int AS count,
          count(*) FILTER (WHERE (s.facts->>'litigated')::boolean)::int AS "litigatedCount",
          sum((s.facts->>'billingsAmount')::numeric)::text AS "billingsAmount",
          sum(sum((s.facts->>'billingsAmount')::numeric)) OVER ()::text AS "totalBillings",
          jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'lob',i.line_of_business,
            'sourceStatus',i.source_claim_status,'ownerId',i.owner_id,'version',i.version) ORDER BY i.id) AS items
          FROM cw_items i JOIN cw_showcase_records s ON s.item_id=i.id WHERE ${associated}
          AND i.external_claim_number IS NOT NULL AND ($4='all' OR i.lifecycle=$4)
          AND (cardinality($5::text[])=0 OR i.line_of_business=ANY($5)) AND ($6='' OR i.owner_id=$6) AND (NOT $7 OR i.owner_id=$3)
          AND ($8='' OR i.source_claim_status=$8)
          GROUP BY ${columns[groupBy]} ORDER BY ${columns[groupBy]}`,
          [...principalScope(u),status,lines,ownerId,assignedOnly,sourceStatus])
        const names = new Map(directory(true,true).employees.map(user => [user.principalId,user.displayName]))
        return { dataset: 'CMS-MCP', groupBy, total: rows.reduce((sum,r) => sum + r.count, 0),
          totalBillings: rows[0]?.totalBillings ?? '0.00', litigatedCount: rows.reduce((sum,r) => sum + r.litigatedCount, 0),
          groups: rows.map(({ totalBillings, ...r }) => ({ ...r, label: groupBy === 'adjuster' ? names.get(r.key) ?? r.key : r.key })) }
      }, true)
    },
    assertChatScope(ctx, raw, dependencies = []) {
      return run(ctx, (db, u) => inspect(db, u, normalizeChatScope(raw), dependencies), true)
    },
    chatSearch(ctx, { query = '', assignedOnly = false, dueToday = false, waitingOnly = false, offset = 0, limit = 12, status = 'open', lob = '', lobs, ownerId = '', sourceStatus = '' } = {}) {
      const lines = businessLines(lob, lobs, 'invalid_claim_search')
      if (!['open', 'closed', 'all'].includes(status) || (sourceStatus && !claimSourceStatuses.includes(sourceStatus)) || typeof query !== 'string' || query.length > 200 || typeof assignedOnly !== 'boolean' ||
        typeof dueToday !== 'boolean' || typeof waitingOnly !== 'boolean' || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail(400, 'invalid_claim_search')
      return run(ctx, async (db, u) => {
        if (ownerId && ownerId !== u.id && u.role !== 'claims_admin') fail(403, 'forbidden')
        const ranked = (await rankedClaims(db, u, /^CLM-\d{6}$/i.test(query.trim()) ? 'all' : status, assignedOnly))
          .filter(i => (!lines.length || lines.includes(i.lob)) && (!ownerId || i.ownerId === ownerId) &&
            (!sourceStatus || i.sourceStatus === sourceStatus))
        const items = matchingClaims(ranked, { query, dueToday, waitingOnly })
        return { items: items.slice(offset, offset + limit), total: items.length, asOf,
          dependencies: items.map(i => ({ claimId: i.id, claimVersion: i.version })) }
      }, true)
    },
    chatTargetCandidates(ctx, query) {
      return run(ctx, (db, u) => searchChatTargets(db, principalScope(u), { associated, evidenceTable }, query), true)
    },
    chatBrief(ctx, claimId) {
      return run(ctx, async (db, u) => {
        const result = await db.query(`SELECT i.* FROM cw_items i WHERE ${associated} AND i.id=$4`, [...principalScope(u),claimId])
        const [item] = rank(result.rows, asOf, connected)
        if (!item) fail(404, 'not_found')
        return {item}
      }, true)
    },
    chatDocuments(ctx, claimId) {
      if (!identifier(claimId)) fail(400, 'invalid_claim_search')
      return run(ctx, async (db, u) => {
        const [claim] = await inspect(db, u, { kind: 'claim', claimIds: [claimId] })
        const { rows } = await db.query(`SELECT id,title,document->>'kind' AS kind,(document->>'version')::int AS version
          FROM ${evidenceTable} WHERE item_id=$1 AND document IS NOT NULL ORDER BY title,id`, [claimId])
        return { claimVersion: claim.claimVersion, items: rows }
      }, true)
    },
    chatEvidenceIndex(ctx, raw, claimId) {
      const scope = normalizeChatScope(raw)
      const ids = selectedDocumentIds(scope, claimId)
      if (!scope.claimIds?.includes(claimId)) fail(404, 'not_found')
      return run(ctx, async (db, u) => {
        const deps = await inspect(db, u, scope)
        // The model can discover passage labels. Passage text needs a separate versioned read.
        const { rows } = await db.query(`SELECT id,title,document->>'kind' AS kind,document->>'source' AS source,
          (document->>'version')::int AS version,document->>'asOf' AS "asOf",
          (SELECT jsonb_agg(jsonb_build_object('id',a->>'id','label',a->>'label') ORDER BY ordinal)
           FROM jsonb_array_elements(document->'anchors') WITH ORDINALITY AS passage(a,ordinal)) AS anchors
          FROM ${evidenceTable} WHERE item_id=$1 AND ($2::text[] IS NULL OR id=ANY($2)) AND document IS NOT NULL ORDER BY as_of,id`,
          [claimId, ids ?? null])
        return { item: { version: deps.find(d => d.claimId === claimId).claimVersion }, documents: rows }
      }, true)
    },
    chatSource(ctx, source) {
      const ref = citation(source)
      return run(ctx, (db, u) => resolveDocument(db, u, ref), true)
    },
    citedChatSource(ctx, id, source) {
      const ref = citation(source)
      return run(ctx, async (db, u) => {
        await owned(db, u, id)
        const matches = await db.query(
          `SELECT scope,dependencies FROM cw_chat_turns WHERE conversation_id=$1 AND state='completed'
           AND answer->'sources' @> $2::jsonb ORDER BY created_at DESC`, [id, JSON.stringify([ref])],
        )
        if (!matches.rowCount) fail(404, 'not_found')
        const current = await revisions(db, u, matches.rows.map(t => t.scope), matches.rows.flatMap(t => t.dependencies))
        let stale = false
        for (const t of matches.rows) {
          try { checkMembership(t.scope, [ref]); validate(t.scope, t.dependencies, current) }
          catch (e) {
            if (!unavailable(e)) throw e
            if (e.code === 'stale_version') stale = true
            continue
          }
          return resolveDocument(db, u, ref)
        }
        fail(stale ? 409 : 404, stale ? 'stale_version' : 'not_found')
      }, true)
    },
    openConversation(ctx, raw, { fresh = false } = {}) {
      if (typeof fresh !== 'boolean') fail(400, 'invalid_chat_scope')
      const scope = normalizeChatScope(raw)
      return run(ctx, async (db, u) => {
        await inspect(db, u, scope)
        const row = (await db.query(
          `INSERT INTO cw_chat_conversations(tenant,profile,actor,subject,id,scope,reuse_by_scope) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(tenant,profile,actor,subject,scope) WHERE reuse_by_scope DO UPDATE SET updated_at=clock_timestamp() RETURNING *`,
          [...owners(u), randomUUID(), scope, !fresh],
        )).rows[0]
        return (await read(db, u, row, true)).conversation
      })
    },
    updateChatScope(ctx, id, raw, expectedRevision, resetFocus = false) {
      const scope = normalizeChatScope(raw)
      if (!positive(expectedRevision)) fail(400, 'invalid_scope_revision')
      return run(ctx, async (db, u) => {
        const row = await owned(db, u, id, true)
        if (row.scope_revision !== expectedRevision) fail(409, 'scope_changed')
        await inspect(db, u, scope, [], true)
        const busy = await db.query(`SELECT 1 FROM cw_chat_turns WHERE conversation_id=$1
          AND (state='awaiting_input' OR (state='running' AND lease_until > clock_timestamp()))`, [id])
        if (busy.rowCount) fail(409, 'chat_turn_busy')
        const focus = scope.claimIds ? scope : null
        const updated = (await db.query(`UPDATE cw_chat_conversations SET scope=$2,
          focus=CASE WHEN $4 OR scope IS DISTINCT FROM $2 THEN $3 ELSE focus END,
          scope_revision=scope_revision + CASE WHEN scope IS DISTINCT FROM $2 OR ($4 AND focus IS DISTINCT FROM $3) THEN 1 ELSE 0 END,
          updated_at=clock_timestamp(),reuse_by_scope=false WHERE id=$1 RETURNING *`, [id, scope, focus, resetFocus])).rows[0]
        return (await read(db, u, updated, true)).conversation
      })
    },
    chatConversations(ctx) {
      return run(ctx, async (db, u) => {
        const rows = await db.query(
          `SELECT * FROM cw_chat_conversations WHERE tenant=$1 AND profile=$2 AND actor=$3 AND subject=$4
           ORDER BY updated_at DESC,id`, owners(u),
        )
        const current = await revisions(db, u, rows.rows.map(row => row.scope), [])
        const items = []
        for (const row of rows.rows) {
          try { validate(row.scope, [], current) }
          catch (e) { if (unavailable(e)) continue; throw e }
          items.push(header(row))
        }
        return { items }
      }, true)
    },
    conversation(ctx, id) {
      return run(ctx, async (db, u) => (await read(db, u, await owned(db, u, id), true)).conversation, true)
    },
    startChatTurn(ctx, id, { requestId, question, expectedRevision, expectedFocus, planned = false, timeZone = 'UTC', excludedClaimIds = [], excludedDocumentIds = [], excludedPreviousTurnId }) {
      if (!identifier(requestId) || typeof question !== 'string' || !question.trim() || question.length > 4000)
        fail(400, 'invalid_chat_turn')
      if (typeof planned !== 'boolean') fail(400, 'invalid_chat_turn')
      if (![excludedClaimIds, excludedDocumentIds].every(list => Array.isArray(list) && list.length <= 512 && list.every(identifier)))
        fail(400, 'invalid_chat_turn')
      if (excludedPreviousTurnId !== undefined && !identifier(excludedPreviousTurnId)) fail(400, 'invalid_chat_turn')
      const exclusions = { excludedClaimIds, excludedDocumentIds, ...(excludedPreviousTurnId && { excludedPreviousTurnId }) }
      const checkedFocus = expectedFocus == null ? null : normalizeChatScope(expectedFocus)
      if (typeof timeZone !== 'string' || timeZone.length > 100) fail(400, 'invalid_time_zone')
      try { new Intl.DateTimeFormat('en', { timeZone }) } catch { fail(400, 'invalid_time_zone') }
      return run(ctx, async (db, u) => {
        const row = await owned(db, u, id, true)
        if (row.scope_revision !== (expectedRevision ?? 1)) fail(409, 'scope_changed')
        if (row.scope.kind === 'workspace' && !planned) fail(400, 'select_claim_scope')
        await db.query(`UPDATE cw_chat_turns SET state='failed',error_code='turn_interrupted' WHERE conversation_id=$1
          AND state='running' AND lease_until <= clock_timestamp()`, [id])
        const existing = (await db.query(
          'SELECT * FROM cw_chat_turns WHERE conversation_id=$1 AND request_id=$2', [id, requestId],
        )).rows[0]
        if (existing && (existing.question !== question.trim() || existing.scope_revision !== row.scope_revision || existing.planned !== planned)) fail(409, 'request_id_conflict')
        const initialScope = existing?.scope ?? (planned ? { kind: 'portfolio' } : row.scope)
        const history = await read(db, u, row, false, initialScope, existing?.state === 'completed' ? undefined : existing?.id,
          existing?.plan, existing ? undefined : excludedPreviousTurnId)
        if (existing && existing.state !== 'failed')
          return { ...history, started: false, turnId: existing.id }
        if (!existing && planned && expectedFocus !== undefined && !isDeepStrictEqual(checkedFocus, history.conversation.focus ?? null))
          fail(409, 'scope_changed')
        if ((await db.query("SELECT 1 FROM cw_chat_turns WHERE conversation_id=$1 AND state IN ('running','awaiting_input')", [id])).rowCount)
          fail(409, 'chat_turn_busy')
        const turnId = existing?.id ?? randomUUID(), attemptId = randomUUID()
        await db.query(
          `INSERT INTO cw_chat_turns(id,conversation_id,request_id,attempt_id,question,state,dependencies,scope,scope_revision,planned,time_zone,exclusions,lease_until)
           VALUES($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10,$11,clock_timestamp()+interval '3 minutes')
           ON CONFLICT(conversation_id,request_id) DO UPDATE SET state='running',attempt_id=EXCLUDED.attempt_id,
           dependencies=CASE WHEN cw_chat_turns.planned THEN cw_chat_turns.dependencies ELSE EXCLUDED.dependencies END,
           lease_until=EXCLUDED.lease_until,
           activity='[]',answer=NULL,error_code=NULL`,
          [turnId, id, requestId, attemptId, question.trim(), JSON.stringify(planned ? [] : history.dependencies), initialScope, row.scope_revision, planned, timeZone, exclusions],
        )
        await db.query('UPDATE cw_chat_conversations SET updated_at=clock_timestamp() WHERE id=$1', [id])
        return { ...history, started: true, turnId, attemptId, planned, question: question.trim(),
          scope: initialScope, plan: existing?.plan, replies: existing?.replies ?? [], timeZone: existing?.time_zone ?? timeZone,
          exclusions: existing?.exclusions ?? exclusions }
      })
    },
    bindTurnPlan(ctx, id, turnId, attemptId, scope, plan, focus, matched = []) {
      const effective = normalizeChatScope(scope)
      if (effective.kind === 'workspace') fail(400, 'select_claim_scope')
      return run(ctx, async (db, u) => {
        const { row, turn } = await active(db, u, id, turnId, attemptId)
        const history = await read(db, u, row, false, effective, turnId, plan)
        // A model clarification resumes within its original evidence scope. Recheck
        // every read that informed that question before using its reply.
        const choices = continuation(turn.replies)
        const previous = choices.resumeModel ? turn.dependencies : (choices.chooseCandidate ? [choices.chooseCandidate] : [])
        const dependencies = await inspect(db, u, effective, mergeDependencies(history.dependencies, previous, matched), true)
        await db.query('UPDATE cw_chat_turns SET scope=$2,plan=$3,dependencies=$4 WHERE id=$1',
          [turnId, effective, plan, JSON.stringify(dependencies)])
        if (focus && effective.claimIds?.length) await db.query('UPDATE cw_chat_conversations SET focus=$2 WHERE id=$1', [id, effective])
        return { ...history, dependencies }
      })
    },
    pauseChatTurn(ctx, id, turnId, attemptId, proposed, origin, dependencies = []) {
      const pending = checkedQuestion(proposed, origin)
      return run(ctx, async (db, u) => {
        const { turn } = await active(db, u, id, turnId, attemptId)
        await checkCandidate(db, u, pending.candidate, true)
        const deps = await inspect(db, u, turn.scope, mergeDependencies(turn.dependencies, dependencies), true)
        await db.query("UPDATE cw_chat_turns SET state='awaiting_input',pending_question=$2,dependencies=$3 WHERE id=$1",
          [turnId, pending, JSON.stringify(deps)])
      })
    },
    replyChatTurn(ctx, id, input) {
      const { requestId, turnId, questionId, expectedRevision } = input
      if (![requestId, turnId, questionId].every(identifier) || !positive(expectedRevision)) fail(400, 'invalid_question_answer')
      return run(ctx, async (db, u) => {
        const row = await owned(db, u, id, true)
        const turn = (await db.query('SELECT * FROM cw_chat_turns WHERE id=$1 AND conversation_id=$2 FOR UPDATE', [turnId,id])).rows[0]
        if (!turn) fail(404, 'not_found')
        const prior = turn.replies.find(r => r.requestId === requestId || r.question.id === questionId)
        if (prior) {
          if (prior.question.id !== questionId || !isDeepStrictEqual(checkedReply(input, prior.question), prior.cancel ? { cancel: true } : { answer: prior.answer }))
            fail(409, 'question_already_answered')
          return { started: false, turnId }
        }
        if (row.scope_revision !== expectedRevision) fail(409, 'scope_changed')
        if (turn.state !== 'awaiting_input' || turn.pending_question?.id !== questionId) fail(409, 'question_changed')
        const pending = turn.pending_question
        const reply = checkedReply(input, pending)
        const replies = [...turn.replies, { requestId, question: pending, ...reply }]
        if (reply.cancel) {
          await db.query("UPDATE cw_chat_turns SET state='cancelled',pending_question=NULL,replies=$2 WHERE id=$1", [turnId,JSON.stringify(replies)])
          return { started: false, turnId }
        }
        await inspect(db, u, turn.scope, turn.dependencies, true)
        await checkCandidate(db, u, pending.candidate, true)
        const attemptId = randomUUID()
        await db.query(`UPDATE cw_chat_turns SET state='running',attempt_id=$2,lease_until=clock_timestamp()+interval '3 minutes',
          pending_question=NULL,replies=$3 WHERE id=$1`, [turnId,attemptId,JSON.stringify(replies)])
        const history = await read(db, u, row, false, turn.scope, turnId, turn.plan)
        return { ...history, started: true, turnId, attemptId, planned: true, question: turn.question, scope: turn.scope, plan: turn.plan, replies, timeZone: turn.time_zone, exclusions: turn.exclusions }
      })
    },
    setChatActivity(ctx, id, turnId, attemptId, activity, dependencies = []) {
      return run(ctx, async (db, u) => {
        const { turn } = await active(db, u, id, turnId, attemptId)
        const deps = await inspect(db, u, turn.scope, mergeDependencies(turn.dependencies, dependencies), true)
        await db.query(`UPDATE cw_chat_turns SET activity=$2,dependencies=$3,
          lease_until=clock_timestamp()+interval '3 minutes' WHERE id=$1`,
          [turnId, JSON.stringify(activity), JSON.stringify(deps)])
      })
    },
    finishChatTurn(ctx, id, turnId, attemptId, { answer, activity = [], dependencies = [] }) {
      return run(ctx, async (db, u) => {
        const { turn } = await active(db, u, id, turnId, attemptId)
        const deps = await inspect(db, u, turn.scope, mergeDependencies(turn.dependencies, dependencies), true)
        await checkWork(db, u, { ...turn, answer })
        // Persist only citations whose source version was authorized and pinned by this turn.
        for (const source of answer.sources ?? []) {
          const ref = citation(source)
          if (!deps.some(dep => dep.claimId === ref.claimId && dep.claimVersion === ref.claimVersion &&
              dep.documentId === ref.documentId && dep.documentVersion === ref.documentVersion)) fail(404, 'not_found')
        }
        await db.query(`UPDATE cw_chat_turns SET state='completed',answer=$2,activity=$3,dependencies=$4 WHERE id=$1`,
          [turnId, answer, JSON.stringify(activity), JSON.stringify(deps)])
        await db.query('UPDATE cw_chat_conversations SET updated_at=clock_timestamp() WHERE id=$1', [id])
      })
    },
    failChatTurn(ctx, id, turnId, attemptId, code) {
      return run(ctx, async (db, u) => {
        await owned(db, u, id, true)
        await db.query(`UPDATE cw_chat_turns SET state='failed',error_code=$4 WHERE conversation_id=$1 AND id=$2
          AND attempt_id=$3 AND state='running'`, [id, turnId, attemptId, code])
      })
    },
  }
}
