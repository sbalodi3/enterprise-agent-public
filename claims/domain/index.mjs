import { presentWorkQuery } from './work-query.mjs'
import { CMS_USERS } from '../auth/roster.mjs'
import { showcaseCapabilities } from './showcase-capabilities.mjs'
import { activeDataset, claimLines, supervisesClaims } from './claim-access.mjs'
import { showcaseDomain, seedShowcase } from './showcase.mjs'
import { sessionRecords, migrateSessions } from './sessions.mjs'
import { chatConversations } from './chat.mjs'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { AS_OF, PROFILE, fixtureEvents, seedData } from './fixtures.mjs'

export { AS_OF, PROFILE, fixtureEvents }
export class DomainError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}
const fail = (status, code) => {
  throw new DomainError(status, code)
}
const validTrace = (value, size) =>
  typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value) && !/^0+$/.test(value)
const traceAnchor = (traceId, spanId) =>
  validTrace(traceId, 32) && validTrace(spanId, 16) ? { traceId, spanId } : null
const first = (result) => result.rows[0]
const iso = (value) => (value ? new Date(value).toISOString() : null)
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  )
}
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const demand = (actual, expected) => {
  if (!Number.isInteger(expected)) fail(400, 'expected_version_required')
  if (actual !== expected) fail(409, 'stale_version')
}
const textValue = (value, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_input')
  return value.trim()
}
export async function transaction(pool, fn, snapshot = false) {
  const db = await pool.connect()
  try {
    await db.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN')
    const result = await fn(db)
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally {
    db.release()
  }
}
export async function migrate(pool) {
  const migrations = await Promise.all(
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020'].map((version) =>
      readFile(new URL('./migrations/' + version + '.sql', import.meta.url), 'utf8'),
    ),
  )
  await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(72735100)')
    for (const sql of migrations) await db.query(sql)
    await migrateSessions(db)
  })
}
export async function seed(pool, { showcase = false, cmsSnapshot = null } = {}) {
  await transaction(pool, async (db) => {
    if (showcase) return seedShowcase(db, cmsSnapshot)
    if (first(await db.query('SELECT 1 FROM cw_showcase_records LIMIT 1')))
      throw new Error('legacy_requires_isolated_database')
    await seedData(db)
    await db.query(
      "INSERT INTO cw_readers SELECT id,'alex' FROM cw_items WHERE id='WC-102' AND owner_id='maya' AND version=1 ON CONFLICT DO NOTHING",
    )
  })
}
async function identity(db, ctx) {
  if (!ctx?.principalId || !ctx.tenantId) fail(403, 'forbidden')
  const row = first(
    await db.query('SELECT * FROM cw_principals WHERE tenant=$1 AND profile=$2 AND id=$3', [
      ctx.tenantId,
      ctx.profileId ?? PROFILE,
      ctx.principalId,
    ]),
  )
  if (!row) fail(403, 'forbidden')
  return { ...row, subject: ctx.subject ?? row.id }
}
const access =
  `${activeDataset} AND i.tenant=$1 AND i.profile=$2 AND (i.owner_id=$3 OR $4 OR EXISTS(SELECT 1 FROM cw_readers r WHERE r.item_id=i.id AND r.principal_id=$3) OR EXISTS(SELECT 1 FROM cw_team_members tm WHERE tm.tenant=i.tenant AND tm.profile=i.profile AND tm.team_id=i.owner_id AND tm.member_id=$3))`
const scope = (u) => [u.tenant, u.profile, u.id, supervisesClaims(u.role)]
async function visible(db, u, id, lock = false) {
  const row = first(
    await db.query(
      `SELECT i.* FROM cw_items i WHERE ${access} AND i.id=$5 ${lock ? 'FOR UPDATE OF i' : ''}`,
      [...scope(u), id],
    ),
  )
  if (!row) fail(404, 'not_found')
  return row
}
const canAct = (u, i) => {
  if (i.owner_id !== u.id && !supervisesClaims(u.role)) fail(403, 'read_only')
}
const itemCard = (r, asOf, showcase = false) => ({
  id: r.id,
  ...(r.external_claim_number && { claimNumber: r.external_claim_number, lob: r.line_of_business, sourceStatus: r.source_claim_status, policyNumber: r.policy_number }),
  type: r.type,
  state: r.state,
  lifecycle: r.lifecycle ?? 'open',
  title: r.title,
  ownerId: r.owner_id,
  version: r.version,
  section: showcase
    ? ({ waiting: 'waiting', review: 'ready' }[r.state] ?? 'must')
    : r.due_at && new Date(r.due_at).valueOf() <= Date.parse(asOf) + 8 * 3600000
      ? 'must'
      : r.state === 'waiting'
        ? 'waiting'
        : 'ready',
  reason: r.reason,
  nextAction: r.next_action,
  dueAt: iso(r.due_at),
  asOf: iso(r.as_of),
  source: r.source,
})
const order = { must: 0, ready: 1, waiting: 2 }
export function rank(items, asOf = AS_OF, showcase = false) {
  return items
    .filter((r) => !showcase || r.state !== 'filed')
    .map((r) => itemCard(r, asOf, showcase))
    .sort(
      (a, b) =>
        order[a.section] - order[b.section] ||
        (showcase && Number(!a.dueAt) - Number(!b.dueAt)) ||
        (a.dueAt ?? '~').localeCompare(b.dueAt ?? '~') ||
        a.id.localeCompare(b.id),
    )
}
async function addEvent(db, id, kind, summary, source, u, evidenceId = null, anchorId = null) {
  await db.query(
    'INSERT INTO cw_events(id,item_id,kind,summary,at,source,actor,subject_id,evidence_id,anchor_id) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP,$5,$6,$7,$8,$9)',
    [randomUUID(), id, kind, summary, source, u?.id ?? null, u?.subject ?? null, evidenceId, anchorId],
  )
}
async function mail(db, i, kind, summary, source, recipient = i.owner_id) {
  const id = randomUUID()
  await db.query(
    'INSERT INTO cw_mail(id,item_id,recipient,kind,summary,source,at) VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)',
    [id, i.id, recipient, kind, summary, source],
  )
  return id
}
const proposalView = (p) => ({
  id: p.id,
  action: p.action,
  status: p.status,
  version: p.version,
  payload: p.payload,
  digest: p.digest,
  creator: p.creator,
  reviewer: p.reviewer,
  requestId: p.request_id,
})
const opView = (o) => ({
  operationId: o.id,
  workItemId: o.item_id,
  state: o.state,
  receiptId: o.receipt_id,
  proposalId: o.proposal_id,
  version: o.expected_version,
  requestId: o.request_id ?? null,
})
const wageView = (w) => ({
  requestId: w.request_id,
  workItemId: w.item_id,
  state: w.state,
  operationId: w.operation_id,
  actorId: w.requested_by ?? w.owner_id,
  taskId: w.partner_task_id ?? null,
  contextId: w.partner_context_id ?? null,
  artifactId: w.artifact_id ?? null,
})
const evView = (e) => ({ id: e.id, title: e.title, source: e.source, asOf: iso(e.as_of) })
async function propose(db, i, user, action, lost = false, requestId = null) {
  const source = first(
    await db.query('SELECT id FROM cw_evidence WHERE item_id=$1 ORDER BY as_of DESC,id LIMIT 1', [i.id]),
  )
  const payload = {
    action,
    workItemId: i.id,
    version: i.version,
    profileId: i.profile,
    ownerId: i.owner_id,
    field: 'reviewNote',
    previousValue: i.review_note,
    proposedValue: requestId
      ? 'Examiner reviewed synthetic partner wage evidence.'
      : 'Examiner reviewed the synthetic work item.',
    evidenceId: source?.id ?? null,
  }
  const p = first(
    await db.query(
      `INSERT INTO cw_proposals(id,item_id,version,action,status,payload,digest,creator,simulate_lost_ack,request_id)
    VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), i.id, i.version, action, payload, digest(payload), user.id, lost, requestId],
    ),
  )
  await addEvent(db, i.id, 'proposal.prepared', 'Review proposal prepared', action, user)
  return proposalView(p)
}
async function applyFixture(db, i, f, eventId, u) {
  await db.query('INSERT INTO cw_evidence VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)', [
    randomUUID(),
    i.id,
    f.source,
    f.title,
    f.body,
  ])
  await addEvent(db, i.id, f.kind, f.summary, f.source, u)
  const mailId = await mail(db, i, 'review', f.summary, f.source)
  await db.query('UPDATE cw_mail SET obligation_event=$2 WHERE id=$1', [mailId, eventId])
  const changed = first(
    await db.query(
      'UPDATE cw_items SET state=$2,reason=$3,next_action=$4,source=$5,as_of=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 RETURNING *',
      [i.id, f.state, f.summary, f.next, f.source],
    ),
  )
  await expireReviews(db, i.id)
  return changed
}
// The caller holds the work item lock and has advanced its revision. Each pending
// proposal describes the prior revision; wake any workflow waiting for its review.
async function expireReviews(db, itemId) {
  const expired = await db.query(
    "UPDATE cw_proposals SET status='stale' WHERE item_id=$1 AND status='pending' RETURNING request_id",
    [itemId],
  )
  for (const p of expired.rows) {
    if (!p.request_id) continue
    const changed = await db.query(
      "UPDATE cw_wages SET state='stale' WHERE request_id=$1 AND state='awaiting-review'",
      [p.request_id],
    )
    if (changed.rowCount) await enqueueWage(db, p.request_id, 'review')
  }
}
const cmsPrincipalIds = new Set(CMS_USERS.map(person => person.principalId))
async function targetMember(db, u, id) {
  if (cmsPrincipalIds.has(id)) {
    const active = await db.query("SELECT 1 FROM cw_datasets WHERE id='cms-mcp' AND active FOR SHARE")
    if (!active.rowCount) fail(404, 'not_found')
  }
  const target = first(
    await db.query('SELECT * FROM cw_principals WHERE tenant=$1 AND profile=$2 AND id=$3', [
      u.tenant,
      u.profile,
      id,
    ]),
  )
  if (!target) fail(404, 'not_found')
  return target
}
async function enqueueWage(db, requestId, kind, eventId = null) {
  await db.query('INSERT INTO cw_wage_commands(id,request_id,kind,event_id) VALUES($1,$2,$3,$4)', [
    randomUUID(),
    requestId,
    kind,
    eventId,
  ])
}
async function wage(db, id, lock = false) {
  const w = first(
    await db.query('SELECT * FROM cw_wages WHERE request_id=$1' + (lock ? ' FOR UPDATE' : ''), [id]),
  )
  if (!w) fail(404, 'not_found')
  return w
}
export function createDomain(pool, { asOf = AS_OF, showcase = null } = {}) {
  const run = (ctx, fn, snapshot = false) =>
    transaction(pool, async (db) => fn(db, await identity(db, ctx)), snapshot)
  const connected =
    showcase &&
    showcaseDomain({
      pool,
      juris: showcase.juris,
      partner: showcase.partner,
      run,
      transaction,
      visible,
      canAct,
      demand,
      fail,
      digest,
      addEvent,
      mail,
      expireReviews,
      enqueueWage,
      proposalView,
      opView,
      wageView,
      wage,
    })
  async function mailbox(db, u) {
    const rows = await db.query(
      `SELECT m.*,EXISTS(SELECT 1 FROM cw_mail_reads mr WHERE mr.mail_id=m.id AND mr.user_id=$3) AS personally_read FROM cw_mail m JOIN cw_items i ON i.id=m.item_id WHERE ${access} AND (m.recipient=$3 OR EXISTS(SELECT 1 FROM cw_team_members tm WHERE tm.tenant=i.tenant AND tm.profile=i.profile AND tm.team_id=m.recipient AND tm.member_id=$3)) ORDER BY m.at DESC,m.id`,
      scope(u),
    )
    return {
      items: rows.rows.map((m) => ({
        id: m.id,
        itemId: m.item_id,
        kind: m.kind,
        summary: m.summary,
        status: m.recipient !== u.id && m.personally_read && m.status === 'unread' ? 'read' : m.status,
        at: iso(m.at),
        source: m.source,
        obligationEvent: m.obligation_event,
        evidenceId: m.evidence_id,
        recipientId: m.recipient,
      })),
    }
  }

  async function readWorkQuery(db, u, plan) {
    if (plan?.kind !== 'workbench' || !['actions', 'inbox', 'unread'].includes(plan.operation)) fail(400, 'invalid_work_query')
    const { items: messages } = await mailbox(db, u)
    if (plan.operation !== 'actions') return presentWorkQuery(plan.operation, [], messages, u.id)
    // Link only the inbox obligation driving the current queue action. Other obligations on this item remain independent.
    const { rows } = await db.query(`SELECT i.*, (
      SELECT m.id FROM cw_mail m WHERE m.item_id=i.id AND m.recipient=$3 AND m.obligation_event IS NOT NULL
      AND m.status NOT IN ('answered','resolved') AND (m.summary=i.reason AND m.source=i.source OR
        i.state='review' AND EXISTS(SELECT 1 FROM cw_wages w WHERE w.item_id=i.id AND w.event_id=m.obligation_event
          AND w.state='awaiting-review'))
      ORDER BY m.at DESC,m.id LIMIT 1
    ) AS linked_obligation FROM cw_items i WHERE ${access} AND i.owner_id=$3 AND i.lifecycle='open'`, scope(u))
    return presentWorkQuery(plan.operation, rank(rows, asOf, Boolean(connected)), messages, u.id,
      new Map(rows.map(row => [row.id, row.linked_obligation])))
  }
  return {
    ...sessionRecords(run, visible),
    ...chatConversations({ run, rank, asOf, connected: Boolean(connected), readWorkQuery }),
    workQuery(ctx, plan) { return run(ctx, (db, u) => readWorkQuery(db, u, plan), true) },
    portfolio(ctx, { ranking = 'rules', status = 'open', query = '', lob = '', ownerId = '' } = {}) {
      if (!['open','closed','all'].includes(status) || (lob && !claimLines.includes(lob)) || typeof query !== 'string' || query.length > 200) fail(400, 'invalid_claim_search')
      if (!['rules', 'due-date'].includes(ranking)) fail(400, 'unsupported_ranking')
      return run(
        ctx,
        async (db, u) => {
          if (ownerId && ownerId !== u.id && u.role !== 'claims_admin') fail(403, 'forbidden')
          const exact = /^CLM-\d{6}$/i.test(query.trim())
          const result = await db.query(`SELECT i.* FROM cw_items i WHERE ${access}
            AND ($5='all' OR i.lifecycle=$5) AND ($6='' OR i.line_of_business=$6)
            AND ($7='' OR i.owner_id=$7)
            AND ($8='' OR position(lower($8) in lower(concat_ws(' ', i.id,i.title,i.policy_number,
              i.reason,i.next_action,i.line_of_business,i.source_claim_status)))>0)`,
            [...scope(u), exact ? 'all' : status, lob, ownerId, query.trim()])
          const items = rank(
            result.rows,
            asOf,
            Boolean(connected),
          )
          if (ranking === 'due-date')
            items.sort((a, b) => (connected && Number(!a.dueAt) - Number(!b.dueAt)) || compareDue(a, b))
          const id = randomUUID(),
            counts = { must: 0, ready: 0, waiting: 0, total: items.length }
          for (const item of items) {
            if (item.lifecycle !== 'closed') counts[item.section]++
          }
          const slate = items.map(({ id, version, section, dueAt }) => ({ id, version, section, dueAt }))
          await db.query(
            'INSERT INTO cw_decisions(id,tenant,profile,actor,as_of,slate,ranking,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())',
            [id, u.tenant, u.profile, u.id, asOf, JSON.stringify(slate), ranking],
          )
          return { asOf, decisionSetId: id, items, counts, ranking }
        },
        true,
      )
    },
    detail(ctx, id) {
      return run(
        ctx,
        async (db, u) => {
          const i = await visible(db, u, id)
          const ev = await db.query('SELECT * FROM cw_evidence WHERE item_id=$1 ORDER BY as_of,id', [id])
          const tl = await db.query(
            `SELECT e.id,e.kind,e.summary,e.at,e.source,e.evidence_id AS "evidenceId",e.anchor_id AS "anchorId",(s.document->>'version')::integer AS "documentVersion" FROM cw_events e LEFT JOIN cw_evidence s ON s.id=e.evidence_id WHERE e.item_id=$1 ORDER BY e.at,e.id`,
            [id],
          )
          const pr = await db.query(
            `SELECT p.* FROM cw_proposals p WHERE p.item_id=$5 AND (p.payload->>'privateTo' IS NULL OR p.payload->>'privateTo'=$3 OR EXISTS(SELECT 1 FROM cw_operations op WHERE op.proposal_id=p.id AND op.state='confirmed')) AND
             (p.payload->>'claimId' IS NULL OR EXISTS(SELECT 1 FROM cw_items i WHERE i.id=p.payload->>'claimId' AND ${access}))
             ORDER BY p.version,p.id`,
            [...scope(u), id],
          )
          const proposalIds = new Set(pr.rows.map((p) => p.id))
          const wages = await db.query(
            'SELECT * FROM cw_wages WHERE item_id=$1 ORDER BY started_version DESC,request_id',
            [id],
          )
          const ops = await db.query(
            'SELECT o.*,p.request_id FROM cw_operations o JOIN cw_proposals p ON p.id=o.proposal_id WHERE o.item_id=$1 ORDER BY o.id',
            [id],
          )
          return {
            item: itemCard(i, asOf, Boolean(connected)),
            ...(connected && { showcase: await connected.detail(db, u, i) }),
            evidence: ev.rows.map(evView),
            timeline: tl.rows.map((e) => ({ ...e, at: iso(e.at) })),
            proposals: pr.rows.map(proposalView),
            operations: ops.rows.filter((o) => proposalIds.has(o.proposal_id)).map(opView),
            wages: wages.rows.map(wageView),
            canAct: i.owner_id === u.id || supervisesClaims(u.role),
          }
        },
        true,
      )
    },
    evidence(ctx, id, { decisionSetId } = {}) {
      return run(ctx, async (db, u) => {
        const e = first(
          await db.query(
            `SELECT e.* FROM cw_evidence e JOIN cw_items i ON i.id=e.item_id WHERE ${access} AND e.id=$5`,
            [...scope(u), id],
          ),
        )
        if (!e) fail(404, 'not_found')
        if (decisionSetId) await recordAction(db, u, decisionSetId, e.item_id, 'inspect_evidence')
        return { ...evView(e), body: e.body, itemId: e.item_id }
      })
    },
    mailbox(ctx) {
      return run(ctx, mailbox)
    },
    acknowledge(ctx, id) {
      return run(ctx, async (db, u) => {
        const m = first(
          await db.query(
            `SELECT m.id,m.status,m.recipient FROM cw_mail m JOIN cw_items i ON i.id=m.item_id WHERE ${access} AND m.id=$5 AND (m.recipient=$3 OR EXISTS(SELECT 1 FROM cw_team_members tm WHERE tm.tenant=i.tenant AND tm.profile=i.profile AND tm.team_id=m.recipient AND tm.member_id=$3)) FOR UPDATE OF m`,
            [...scope(u), id],
          ),
        )
        if (!m) fail(404, 'not_found')
        if (m.status === 'unread') {
          if (m.recipient === u.id) await db.query("UPDATE cw_mail SET status='read' WHERE id=$1", [id])
          else await db.query('INSERT INTO cw_mail_reads VALUES($1,$2) ON CONFLICT DO NOTHING', [id, u.id])
          m.status = 'read'
        }
        return { id: m.id, status: m.status }
      })
    },
    peerRequest(ctx, id, b = {}) {
      return run(ctx, async (db, u) => {
        const i = await visible(db, u, id, true)
        demand(i.version, b.expectedVersion)
        const recipient = await targetMember(db, u, b.recipientId)
        await visible(db, recipient, id)
        const message = textValue(b.message, 600)
        const kind = b.kind ?? 'request'
        if (!['question', 'request'].includes(kind)) fail(400, 'invalid_request_kind')
        return { id: await mail(db, i, kind, message, u.id, recipient.id), itemId: id }
      })
    },
    answer(ctx, id, b = {}) {
      return run(ctx, async (db, u) => {
        const question = first(
          await db.query(
            `SELECT m.* FROM cw_mail m JOIN cw_items i ON m.item_id=i.id WHERE ${access} AND m.id=$5 AND m.recipient=$3 AND m.kind='question' FOR UPDATE OF m`,
            [...scope(u), id],
          ),
        )
        if (!question) fail(404, 'not_found')
        if (question.status === 'answered') fail(409, 'question_closed')
        const message = textValue(b.message, 600),
          item = await visible(db, u, question.item_id)
        const target = await targetMember(db, u, question.source)
        await visible(db, target, item.id)
        const reply = await mail(db, item, 'answer', message, u.id, target.id)
        await db.query("UPDATE cw_mail SET status='answered' WHERE id=$1", [id])
        return { id: reply, itemId: item.id }
      })
    },
    claimIntake(ctx, id, { expectedVersion } = {}) {
      return run(ctx, async (db, u) => {
        const item = await visible(db, u, id, true)
        demand(item.version, expectedVersion)
        if (item.type !== 'intake' || item.owner_id !== 'claims-intake') fail(409, 'intake_already_assigned')
        const changed = first(
          await db.query('UPDATE cw_items SET owner_id=$2,version=version+1 WHERE id=$1 RETURNING *', [
            id,
            u.id,
          ]),
        )
        await db.query(
          "UPDATE cw_mail SET recipient=$2,status='unread' WHERE item_id=$1 AND recipient='claims-intake' AND obligation_event IS NOT NULL",
          [id, u.id],
        )
        await addEvent(db, id, 'assignment.claimed', 'Examiner accepted team intake', 'Workbench', u)
        await expireReviews(db, id)
        return itemCard(changed, asOf, Boolean(connected))
      })
    },
    transfer(ctx, id, b = {}) {
      return run(ctx, async (db, u) => {
        const i = await visible(db, u, id, true)
        canAct(u, i)
        demand(i.version, b.expectedVersion)
        if (connected) await connected.assertAvailable(db, id)
        const target = await targetMember(db, u, b.recipientId)
        if (!['adjuster', 'supervisor'].includes(target.role)) fail(400, 'invalid_assignee')
        if (target.id === i.owner_id) fail(409, 'already_assigned')
        await db.query('DELETE FROM cw_readers WHERE item_id=$1', [id])
        const changed = first(
          await db.query('UPDATE cw_items SET owner_id=$2,version=version+1 WHERE id=$1 RETURNING *', [
            id,
            target.id,
          ]),
        )
        await db.query("UPDATE cw_proposals SET status='stale' WHERE item_id=$1 AND status='pending'", [id])
        const stale = await db.query(
          "UPDATE cw_wages SET state='stale' WHERE item_id=$1 AND state IN ('awaiting-partner','awaiting-review') RETURNING request_id",
          [id],
        )
        for (const w of stale.rows) await enqueueWage(db, w.request_id, 'review')
        await db.query(
          "UPDATE cw_mail SET recipient=$2,status='unread' WHERE item_id=$1 AND recipient=$3 AND obligation_event IS NOT NULL AND status<>'resolved'",
          [id, target.id, i.owner_id],
        )
        if (connected && stale.rowCount) {
          await db.query(
            "UPDATE cw_items SET state='ready',reason='Prior wage request closed on transfer',next_action='Request wage evidence' WHERE id=$1",
            [id],
          )
          changed.state = 'ready'
          changed.reason = 'Prior wage request closed on transfer'
          changed.next_action = 'Request wage evidence'
        }
        await addEvent(db, id, 'assignment.transferred', 'Assigned to ' + target.id, 'Workbench', u)
        await mail(db, changed, 'assignment', 'Work transferred to you', 'Workbench')
        return itemCard(changed, asOf, Boolean(connected))
      })
    },
    prepare(ctx, id, b = {}) {
      if (connected) return connected.prepare(ctx, id, b)
      return run(ctx, async (db, u) => {
        const i = await visible(db, u, id, true)
        canAct(u, i)
        demand(i.version, b.expectedVersion)
        const action = b.action ?? 'record-review'
        if (action !== 'record-review') fail(400, 'unsupported_action')
        if (b.decisionSetId) await recordAction(db, u, b.decisionSetId, id, 'prepare_review')
        return propose(db, i, u, action, b.simulateLostAck === true)
      })
    },
    review(ctx, id, b = {}) {
      return run(ctx, async (db, u) => {
        const linked = first(await db.query('SELECT item_id FROM cw_proposals WHERE id=$1', [id]))
        if (!linked) fail(404, 'not_found')
        const i = await visible(db, u, linked.item_id, true)
        canAct(u, i)
        const p = first(await db.query('SELECT * FROM cw_proposals WHERE id=$1 FOR UPDATE', [id]))
        if (connected) await visible(db, u, p.payload.claimId)
        const decision = b.decision
        if (p.payload.privateTo && p.payload.privateTo !== u.id) fail(403,'private_draft')
        if (b.expectedDigest && b.expectedDigest !== p.digest) fail(409,'stale_proposal')
        if (!['approve', 'reject'].includes(decision)) fail(400, 'invalid_decision')
        const status = decision === 'approve' ? 'approved' : 'rejected'
        demand(p.version, b.expectedVersion)
        const prev = first(await db.query('SELECT * FROM cw_operations WHERE proposal_id=$1', [id]))
        if (p.status === status && p.reviewer === u.id)
          return { ...proposalView(p), operation: prev ? opView(prev) : null, operationId: prev?.id ?? null }
        if (p.status !== 'pending') fail(409, 'proposal_closed')
        demand(i.version, p.version)
        if (connected && decision === 'approve') await connected.checkReview(db, u, i, p)
        const changed = first(
          await db.query(
            'UPDATE cw_proposals SET status=$2,reviewer=$3,simulate_lost_ack=simulate_lost_ack OR $4 WHERE id=$1 RETURNING *',
            [id, status, u.id, b.simulateLostAck === true && decision === 'approve'],
          ),
        )
        await addEvent(
          db,
          i.id,
          'proposal.' + status,
          'Examiner ' + status + ' exact proposal',
          'Workbench',
          u,
          connected ? p.payload.evidenceId : null,
          connected ? p.payload.anchorId : null,
        )
        if (connected) await connected.updateReviewState(db, i, changed, decision)
        let op = null
        if (decision === 'approve') {
          const traceId =
            typeof ctx.traceId === 'string' && /^[a-f0-9]{32}$/.test(ctx.traceId) && !/^0+$/.test(ctx.traceId)
              ? ctx.traceId
              : randomUUID().replaceAll('-', '')
          const attestation = {
            traceId,
            ...(typeof ctx.spanId === 'string' &&
            /^[0-9a-f]{16}$/.test(ctx.spanId) &&
            !/^0+$/.test(ctx.spanId)
              ? { spanId: ctx.spanId }
              : {}),
            subject: u.subject,
            principalId: u.id,
            tenantId: u.tenant,
            profileId: u.profile,
            workItemId: i.id,
            agentVersion: 'claims-fixture-v1',
            modelVersion: 'none',
            promptVersion: 'none',
            guardrailVersion: 'demo-policy-v1',
            tool: p.action === 'request_wages' ? 'amazon-mock.query.wage_evidence' : connected ? 'juris.' + p.action : 'simulated.record-review',
            schemaVersion: 1,
            policyDecisionId: randomUUID(),
            payloadHash: p.digest,
            approvalId: id,
            version: p.version,
            evidenceRef: p.payload.evidenceId ?? i.id,
            principalClaimsHash: digest({
              subject: u.subject,
              tenant: u.tenant,
              profile: u.profile,
              role: u.role,
            }),
          }
          op = first(
            await db.query("INSERT INTO cw_operations VALUES($1,$2,$3,$4,'queued',$5,null) RETURNING *", [
              randomUUID(),
              i.id,
              p.id,
              p.version,
              attestation,
            ]),
          )
          if (connected) await connected.saveIntent(db, changed, op)
          await db.query("INSERT INTO cw_outbox(id,operation_id,kind) VALUES($1,$2,'operation.ready')", [
            randomUUID(),
            op.id,
          ])
        }
        if (p.request_id)
          await db.query('UPDATE cw_wages SET state=$2,operation_id=$3 WHERE request_id=$1', [
            p.request_id,
            status,
            op?.id ?? null,
          ])
        if (p.request_id) await enqueueWage(db, p.request_id, 'review')
        return {
          ...proposalView(changed),
          operation: op ? opView({ ...op, request_id: p.request_id }) : null,
          operationId: op?.id ?? null,
        }
      })
    },
    operation(ctx, id) {
      return run(ctx, async (db, u) => {
        const o = first(
          await db.query(
            `SELECT o.*,p.request_id,p.payload->>'claimId' AS target_claim FROM cw_operations o JOIN cw_proposals p ON p.id=o.proposal_id JOIN cw_items i ON i.id=o.item_id WHERE ${access} AND o.id=$5`,
            [...scope(u), id],
          ),
        )
        if (!o) fail(404, 'not_found')
        if (o.target_claim) await visible(db, u, o.target_claim)
        return opView(o)
      })
    },
    fixture(ctx, b = {}) {
      if (connected) fail(400, 'legacy_fixture_disabled')
      return run(ctx, async (db, u) => {
        const f = Object.hasOwn(fixtureEvents, b.fixtureId) ? fixtureEvents[b.fixtureId] : null
        if (!f) fail(400, 'unknown_fixture')
        if (b.fixtureId === 'voice-team-intake' && u.tenant === 'demo' && u.profile === PROFILE) {
          await db.query(
            `INSERT INTO cw_items(id,tenant,profile,owner_id,type,title,state,reason,next_action,as_of,source)
            VALUES('IN-202','demo','claims-v1','claims-intake','intake','Team intake callback','ready','Pending assignment','Claim this intake',$1,'Intake queue') ON CONFLICT DO NOTHING`,
            [AS_OF],
          )
        }
        let i
        if (u.role === 'fixture-service') {
          if (u.id !== 'fixture-ingress' || u.subject !== 'service:fixture-ingress:' + b.fixtureId)
            fail(403, 'invalid_service_fixture')
          i = first(
            await db.query('SELECT * FROM cw_items WHERE tenant=$1 AND profile=$2 AND id=$3 FOR UPDATE', [
              u.tenant,
              u.profile,
              f.itemId,
            ]),
          )
          if (!i) fail(404, 'not_found')
        } else {
          i = await visible(db, u, f.itemId, true)
          if (!(i.owner_id === 'claims-intake' && b.fixtureId === 'voice-team-intake')) canAct(u, i)
        }
        const eventId = textValue(b.eventId, 128)
        const requestId = b.requestId ?? null
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          JSON.stringify([u.tenant, u.profile, eventId]),
        ])
        if (requestId && b.fixtureId !== 'a2a-update') fail(400, 'invalid_fixture_request')
        const existing = first(
          await db.query(
            'SELECT * FROM cw_fixture_deliveries WHERE tenant=$1 AND profile=$2 AND event_id=$3',
            [u.tenant, u.profile, eventId],
          ),
        )
        if (existing) {
          if (existing.fixture_id !== b.fixtureId || existing.request_id !== requestId)
            fail(409, 'event_id_conflict')
          return { eventId, itemId: i.id, duplicate: true, version: i.version }
        }
        if (requestId) {
          const w = await wage(db, requestId, true)
          if (w.item_id !== i.id || w.state !== 'awaiting-partner') fail(409, 'wrong_wage_request')
        }
        await db.query('INSERT INTO cw_fixture_deliveries VALUES($1,$2,$3,$4,$5,$6)', [
          u.tenant,
          u.profile,
          eventId,
          b.fixtureId,
          i.id,
          requestId,
        ])
        if (requestId) await enqueueWage(db, requestId, 'evidence', eventId)
        const changed = requestId ? i : await applyFixture(db, i, f, eventId, u)
        return { eventId, itemId: i.id, duplicate: false, version: changed.version }
      })
    },
    exposure(ctx, id, b = {}) {
      return run(ctx, async (db, u) => {
        if (!Array.isArray(b.itemIds) || b.itemIds.length > 500) fail(400, 'invalid_item_ids')
        const s = await decision(db, u, id)
        for (const itemId of new Set(b.itemIds)) await recordFeedback(db, u, s, itemId, 'exposed', '')
        return { decisionSetId: id, count: new Set(b.itemIds).size }
      })
    },
    feedback(ctx, id, b = {}) {
      return run(ctx, async (db, u) => {
        if (!['selected', 'deferred', 'overridden', 'reviewed'].includes(b.kind))
          fail(400, 'invalid_feedback_kind')
        const s = await decision(db, u, id)
        await recordFeedback(db, u, s, b.itemId, b.kind, b.reason ? textValue(b.reason, 300) : '')
        return { decisionSetId: id, itemId: b.itemId, kind: b.kind }
      })
    },
    dataset(ctx) {
      return run(
        ctx,
        async (db, u) => ({ schemaVersion: 1, synthetic: true, rows: await datasetRows(db, u) }),
        true,
      )
    },
    evaluate(ctx, { k = 3 } = {}) {
      return run(ctx, async (db, u) => scoreBaseline(await datasetRows(db, u), k), true)
    },
    admitWage(ctx, { requestId, workItemId, expectedVersion }) {
      if (connected) return connected.prepare(ctx,workItemId,{ action:'request_wages',expectedVersion,requestId })
      return run(ctx, async (db, u) => {
        textValue(requestId, 128)
        const item = await visible(db, u, workItemId, true)
        canAct(u, item)
        if (!showcaseCapabilities(item).wageRequest) fail(400, 'unsupported_wage_fixture')
        const existing = first(await db.query('SELECT * FROM cw_wages WHERE request_id=$1', [requestId]))
        if (existing) {
          if (existing.item_id !== workItemId || existing.started_version !== expectedVersion)
            fail(409, 'request_id_conflict')
          return wageView(existing)
        }
        demand(item.version, expectedVersion)
        const open = first(
          await db.query(
            "SELECT request_id FROM cw_wages WHERE item_id=$1 AND state IN ('awaiting-partner','awaiting-review','approved','unknown')",
            [workItemId],
          ),
        )
        if (open) fail(409, 'wage_already_open')
        const parent = traceAnchor(ctx.traceId, ctx.spanId)
        const row = first(
          await db.query(
            "INSERT INTO cw_wages(request_id,item_id,state,owner_id,started_version,trace_id,span_id,requested_by) VALUES($1,$2,'awaiting-partner',$3,$4,$5,$6,$7) RETURNING *",
            [
              requestId,
              workItemId,
              item.owner_id,
              item.version,
              parent?.traceId ?? null,
              parent?.spanId ?? null,
              u.id,
            ],
          ),
        )
        await addEvent(db, workItemId, 'wage.requested', 'Wage evidence requested', 'Workbench', u)
        await enqueueWage(db, requestId, 'start')
        return wageView(row)
      })
    },
    async wageDeliveries() {
      const result =
        await pool.query(`SELECT c.id AS "deliveryId",c.kind,w.request_id AS "requestId",w.item_id AS "workItemId",w.state,c.event_id AS "eventId",w.operation_id AS "operationId"
        FROM cw_wage_commands c JOIN cw_wages w ON c.request_id=w.request_id
        WHERE c.delivered_at IS NULL ORDER BY c.seq LIMIT 100`)
      return { items: result.rows }
    },
    async ackWageDelivery({ deliveryId }) {
      const result = await pool.query(
        'UPDATE cw_wage_commands SET delivered_at=COALESCE(delivered_at,CURRENT_TIMESTAMP) WHERE id=$1 RETURNING id',
        [deliveryId],
      )
      if (!result.rowCount) fail(404, 'not_found')
      return { deliveryId }
    },
    async startWage({ requestId, workItemId }) {
      const w = await wage(pool, requestId)
      if (w.item_id !== workItemId) fail(409, 'request_id_conflict')
      return wageView(w)
    },
    acceptWage({ requestId, eventId }) {
      return transaction(pool, async (db) => {
        const initial = await wage(db, requestId)
        const item = first(await db.query('SELECT * FROM cw_items WHERE id=$1 FOR UPDATE', [initial.item_id]))
        const w = await wage(db, requestId, true)
        if (w.event_id === eventId && w.state !== 'awaiting-partner') return wageView(w)
        if (w.state !== 'awaiting-partner' || item.owner_id !== w.owner_id) fail(409, 'wage_closed')
        const d = first(
          await db.query(
            "SELECT * FROM cw_fixture_deliveries WHERE tenant=$1 AND profile=$2 AND event_id=$3 AND request_id=$4 AND item_id=$5 AND fixture_id='a2a-update'",
            [item.tenant, item.profile, eventId, requestId, w.item_id],
          ),
        )
        if (!d) fail(409, 'unverified_partner_event')
        const changed = await applyFixture(db, item, fixtureEvents['a2a-update'], eventId)
        await propose(db, changed, { id: 'wage-service' }, 'record-reviewed-wage-evidence', false, requestId)
        return wageView(
          first(
            await db.query(
              "UPDATE cw_wages SET state='awaiting-review',event_id=$2 WHERE request_id=$1 RETURNING *",
              [requestId, eventId],
            ),
          ),
        )
      })
    },
    async wageStatus({ requestId }) {
      return wageView(await wage(pool, requestId))
    },
    timeoutWage({ requestId, stage }) {
      return transaction(pool, async (db) => {
        const initial = await wage(db, requestId)
        await db.query('SELECT id FROM cw_items WHERE id=$1 FOR UPDATE', [initial.item_id])
        const w = await wage(db, requestId, true)
        const expected = {
          partner: 'awaiting-partner',
          review: 'awaiting-review',
          'awaiting-partner': 'awaiting-partner',
          'awaiting-review': 'awaiting-review',
        }[stage]
        if (!expected) fail(400, 'invalid_wage_stage')
        if (w.state !== expected) return wageView(w)
        await db.query("UPDATE cw_proposals SET status='expired' WHERE request_id=$1 AND status='pending'", [
          requestId,
        ])
        if (connected)
          await db.query(
            "UPDATE cw_items SET state='ready',reason='Wage request timed out',next_action='Follow up on wage evidence' WHERE id=$1",
            [w.item_id],
          )
        await addEvent(db, w.item_id, 'wage.timeout', 'Wage workflow requires follow-up', 'Wage service')
        const item = first(await db.query('SELECT * FROM cw_items WHERE id=$1', [w.item_id]))
        await mail(db, item, 'exception', 'Wage workflow requires follow-up', 'Wage service')
        return wageView(
          first(
            await db.query("UPDATE cw_wages SET state='timed-out' WHERE request_id=$1 RETURNING *", [
              requestId,
            ]),
          ),
        )
      })
    },
    async wageSpan({ requestId }) {
      const r = first(
        await pool.query('SELECT trace_id,span_id FROM cw_wages WHERE request_id=$1', [requestId]),
      )
      return traceAnchor(r?.trace_id, r?.span_id)
    },
    async proposalSpan(id) {
      const r = first(
        await pool.query(
          'SELECT w.trace_id,w.span_id FROM cw_wages w JOIN cw_proposals p ON p.request_id=w.request_id WHERE p.id=$1',
          [id],
        ),
      )
      return traceAnchor(r?.trace_id, r?.span_id)
    },
    async operationSpan({ operationId }) {
      const row = first(
        await pool.query(
          'SELECT attestation->>\'traceId\' AS "traceId",attestation->>\'spanId\' AS "spanId" FROM cw_operations WHERE id=$1',
          [operationId],
        ),
      )
      return row?.traceId && row?.spanId ? row : null
    },
    async dispatchable() {
      const r =
        await pool.query(`SELECT o.*,p.simulate_lost_ack FROM cw_operations o JOIN cw_outbox b ON b.operation_id=o.id JOIN cw_proposals p ON p.id=o.proposal_id
        WHERE o.state='queued' AND p.request_id IS NULL ORDER BY b.created_at,o.id LIMIT 100`)
      return { items: r.rows.map((o) => ({ ...opView(o), simulateLostAck: o.simulate_lost_ack })) }
    },
    dispatchOperation(input) {
      return connected ? connected.dispatch(input, false) : dispatch(pool, input, false)
    },
    ...connected?.public,
    reconcileOperation(input) {
      return connected ? connected.dispatch(input, true) : dispatch(pool, input, true)
    },
  }
}
async function decision(db, u, id) {
  const s = first(
    await db.query('SELECT * FROM cw_decisions WHERE id=$1 AND actor=$2 AND tenant=$3 AND profile=$4', [
      id,
      u.id,
      u.tenant,
      u.profile,
    ]),
  )
  if (!s) fail(404, 'not_found')
  return s
}
async function recordFeedback(db, u, s, itemId, kind, reason) {
  if (!s.slate.some((x) => x.id === itemId)) fail(404, 'not_found')
  await visible(db, u, itemId, true)
  await db.query(
    'INSERT INTO cw_feedback(decision_id,item_id,kind,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [s.id, itemId, kind, reason],
  )
}
async function recordAction(db, u, setId, itemId, action) {
  const s = await decision(db, u, setId)
  const entry = s.slate.find((x) => x.id === itemId)
  if (!entry) fail(404, 'not_found')
  const item = await visible(db, u, itemId)
  if (entry.version !== item.version) return
  await db.query(
    'INSERT INTO cw_decision_actions(decision_id,item_id,action) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [setId, itemId, action],
  )
}
function compareDue(a, b) {
  return (
    (a.dueAt ?? '~').localeCompare(b.dueAt ?? '~') ||
    (a.id ?? a.itemId ?? '').localeCompare(b.id ?? b.itemId ?? '')
  )
}
async function datasetRows(db, u) {
  if (!supervisesClaims(u.role)) fail(403, 'supervisor_required')
  const r = await db.query(
    `SELECT d.id AS "decisionSetId", d.as_of AS "asOf",d.ranking,d.recorded_at AS "recordedAt",d.actor, s.entry->>'id' AS "itemId",
    (s.entry->>'version')::int AS version, s.entry->>'section' AS section,s.position::int AS rank,s.entry->>'dueAt' AS "dueAt",l.label,l.basis,
    COALESCE(l.disputed,false) AS disputed,l.assessments,
    (SELECT min(EXTRACT(EPOCH FROM a.at-d.recorded_at)*1000)::float FROM cw_decision_actions a WHERE a.decision_id=d.id AND a.item_id=i.id AND l.label='priority' AND a.action=l.expected_action AND a.at>=d.recorded_at AND a.at<d.recorded_at+interval '8 hours') AS "firstCorrectMs",
    EXISTS(SELECT 1 FROM cw_feedback f WHERE f.decision_id=d.id AND f.item_id=i.id AND f.kind='exposed') AS exposed,
    ARRAY(SELECT f.kind FROM cw_feedback f WHERE f.decision_id=d.id AND f.item_id=i.id AND f.kind<>'exposed' ORDER BY f.kind) AS feedback
    FROM cw_decisions d CROSS JOIN LATERAL jsonb_array_elements(d.slate) WITH ORDINALITY AS s(entry,position)
    JOIN cw_items i ON i.id=s.entry->>'id' AND i.tenant=d.tenant AND i.profile=d.profile
    LEFT JOIN LATERAL (SELECT CASE WHEN count(DISTINCT label)=1 THEN min(label) END AS label,string_agg(basis,' / ' ORDER BY reviewer) AS basis,
    count(DISTINCT label)>1 AS disputed,CASE WHEN count(DISTINCT coalesce(expected_action,''))=1 THEN min(expected_action) END AS expected_action,
    jsonb_agg(jsonb_build_object('reviewer',reviewer,'label',label,'expectedAction',expected_action) ORDER BY reviewer) AS assessments
    FROM cw_assessments WHERE item_id=i.id AND version=(s.entry->>'version')::int) l ON true
    WHERE d.tenant=$1 AND d.profile=$2 AND ${activeDataset} ORDER BY d.id,s.position`,
    [u.tenant, u.profile],
  )
  return r.rows.map((x) => ({ ...x, asOf: iso(x.asOf) }))
}
export function scoreBaseline(rows, k = 3) {
  if (!Number.isInteger(k) || k < 1 || k > 100) fail(400, 'invalid_review_budget')
  const sets = Map.groupBy(rows, (row) => row.decisionSetId),
    labels = rows.filter((r) => r.label).length
  function measure(ranking) {
    let relevant = 0,
      hits = 0,
      observedTop = 0,
      unlabeledTopK = 0,
      mandatoryMisses = 0,
      eligibleTimingSets = 0
    const times = []
    for (const slate of sets.values()) {
      const ordered = [...slate].sort(
        (a, b) => (ranking === 'rules' ? order[a.section] - order[b.section] : 0) || compareDue(a, b),
      )
      for (const [n, r] of ordered.entries()) {
        if (r.label === 'priority') relevant++
        if (n < k) {
          if (r.label) observedTop++
          else unlabeledTopK++
          if (r.label === 'priority') hits++
        } else if (r.section === 'must') mandatoryMisses++
      }
      if (slate[0].ranking === ranking && slate[0].recordedAt != null) {
        eligibleTimingSets++
        const valid = slate.map((r) => r.firstCorrectMs).filter((n) => Number.isFinite(n) && n >= 0)
        if (valid.length) times.push(Math.min(...valid))
      }
    }
    return {
      ranking,
      precisionAtK: observedTop ? hits / observedTop : null,
      recallAtK: relevant ? hits / relevant : null,
      mandatoryMisses,
      unlabeledTopK,
      meanTimeToFirstCorrectMs: times.length ? times.reduce((x, y) => x + y, 0) / times.length : null,
      timedSets: times.length,
      eligibleTimingSets,
    }
  }
  const rules = measure('rules'),
    dueDate = measure('due-date')
  return {
    synthetic: true,
    baseline: 'mandatory-first-v1',
    k,
    decisionSets: sets.size,
    rows: rows.length,
    labelCoverage: rows.length ? labels / rows.length : null,
    disputedRows: rows.filter((r) => r.disputed).length,
    missingLabelRows: rows.filter((r) => !r.disputed && !r.label).length,
    ...rules,
    rankers: [rules, dueDate],
  }
}
async function dispatch(pool, { operationId, simulateLostAck = false }, reconcile) {
  return transaction(pool, async (db) => {
    const link = first(await db.query('SELECT item_id FROM cw_operations WHERE id=$1', [operationId]))
    if (!link) fail(404, 'not_found')
    const i = first(await db.query('SELECT * FROM cw_items WHERE id=$1 FOR UPDATE', [link.item_id]))
    const o = first(await db.query('SELECT * FROM cw_operations WHERE id=$1 FOR UPDATE', [operationId]))
    const p = first(await db.query('SELECT * FROM cw_proposals WHERE id=$1', [o.proposal_id]))
    if (
      !['queued', 'unknown'].includes(o.state) ||
      (!reconcile && o.state === 'unknown') ||
      (reconcile && o.state !== 'unknown')
    )
      return opView(o)
    const update = async (state, receiptId = null) => {
      const row = first(
        await db.query('UPDATE cw_operations SET state=$2,receipt_id=$3 WHERE id=$1 RETURNING *', [
          o.id,
          state,
          receiptId,
        ]),
      )
      if (p.request_id)
        await db.query('UPDATE cw_wages SET state=$2 WHERE request_id=$1', [p.request_id, state])
      return opView(row)
    }
    let effect = first(await db.query('SELECT * FROM cw_effects WHERE operation_id=$1', [o.id]))
    if (!reconcile) {
      const actor = first(
        await db.query('SELECT * FROM cw_principals WHERE id=$1 AND tenant=$2 AND profile=$3', [
          p.reviewer,
          i.tenant,
          i.profile,
        ]),
      )
      const unresolved = first(
        await db.query(
          "SELECT id FROM cw_operations WHERE item_id=$1 AND id<>$2 AND state='unknown' LIMIT 1",
          [i.id, o.id],
        ),
      )
      if (
        unresolved ||
        !actor ||
        (actor.id !== i.owner_id && !supervisesClaims(actor.role)) ||
        p.status !== 'approved' ||
        p.payload.ownerId !== i.owner_id ||
        i.version !== o.expected_version ||
        p.digest !== digest(p.payload) ||
        o.attestation.payloadHash !== p.digest
      )
        return update('stale')
      effect = first(
        await db.query(
          'INSERT INTO cw_effects(operation_id,receipt_id,payload_digest,applied_payload) VALUES($1,$2,$3,$4) RETURNING *',
          [o.id, 'fixture-' + randomUUID(), p.digest, p.payload],
        ),
      )
      if (simulateLostAck || p.simulate_lost_ack) {
        await addEvent(
          db,
          i.id,
          'operation.unknown',
          'Awaiting destination receipt lookup',
          'Fixture destination',
        )
        return update('unknown')
      }
    }
    if (!effect || effect.payload_digest !== p.digest) return update('unknown')
    await addEvent(
      db,
      i.id,
      'operation.confirmed',
      'Local simulator confirmed the reviewed update',
      'Fixture destination',
    )
    await mail(db, i, 'receipt', 'Reviewed action confirmed by the local simulator', 'Fixture destination')
    await db.query('UPDATE cw_items SET version=version+1,review_note=COALESCE($2,review_note) WHERE id=$1', [
      i.id,
      effect.applied_payload?.proposedValue ?? null,
    ])
    await expireReviews(db, i.id)
    return update('confirmed', effect.receipt_id)
  })
}
