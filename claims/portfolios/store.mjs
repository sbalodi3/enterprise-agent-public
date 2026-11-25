import { createHash, randomUUID } from 'node:crypto'
import { DomainError } from '../domain/index.mjs'
import { approvedDisposition, asOf, records, requestQuestion } from './fixtures.mjs'

import { departmentProfiles } from './profiles.mjs'

const profiles = Object.fromEntries(
  Object.values(departmentProfiles).map((profile) => [profile.id, profile.storageProfile]),
)
const profileIds = Object.values(profiles)
const fail = (status, code) => {
  throw new DomainError(status, code)
}
const date = (value) => new Date(value).toISOString()
const amount = (cents) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
const first = (result) => result.rows[0]
const digest = (payload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex')

async function transaction(pool, fn, readOnly = false) {
  const db = await pool.connect()
  try {
    await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
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

async function employee(db, ctx, required = true) {
  if (!ctx?.tenantId || !ctx.principalId || !ctx.subject) {
    if (required) fail(403, 'portfolio_forbidden')
    return null
  }
  const row = first(
    await db.query(
      'SELECT tenant,id,profile,role FROM cw_principals WHERE tenant=$1 AND id=$2 AND profile=ANY($3::text[]) AND role=ANY($4::text[])',
      [ctx.tenantId, ctx.principalId, profileIds, Object.keys(profiles)],
    ),
  )
  if (row && profiles[row.role] === row.profile) return { ...row, subject: ctx.subject, department: row.role }
  if (required) fail(403, 'portfolio_forbidden')
  return null
}

const recordJoin = 'cw_items i JOIN ep_port_records p ON p.item_id=i.id'
const owned = 'i.tenant=$1 AND i.profile=$2 AND i.owner_id=$3'
const scope = (u) => [u.tenant, u.profile, u.id]
async function record(db, u, id, lock = false) {
  const row = first(
    await db.query(
      `SELECT i.*,p.contents FROM ${recordJoin} WHERE ${owned} AND i.id=$4 ${lock ? 'FOR UPDATE OF i' : ''}`,
      [...scope(u), id],
    ),
  )
  if (!row) fail(404, 'not_found')
  return row
}
function reconcile(contents) {
  const { invoiceRows, stagedRows } = contents
  if (!invoiceRows) return null
  const sum = (rows) => rows.reduce((n, row) => n + row.cents, 0)
  const invoiceCents = sum(invoiceRows),
    stagedCents = sum(stagedRows)
  return { invoiceRows, stagedRows, invoiceCents, stagedCents, varianceCents: stagedCents - invoiceCents }
}
function card(row) {
  const { department, account, priority, linkedClaimId } = row.contents
  const totals = reconcile(row.contents)
  return {
    department,
    id: row.id,
    title: row.title,
    account,
    priority,
    owner: row.owner_id,
    status: row.state,
    dueAt: date(row.due_at),
    linkedClaimId,
    reason: row.reason,
    nextAction: row.next_action,
    version: row.version,
    sourceVersions: row.contents.sources.map((s) => [s.id, s.version]),
    ...(totals && { varianceCents: totals.varianceCents }),
  }
}
async function list(db, u) {
  const { rows } = await db.query(
    `SELECT i.*,p.contents FROM ${recordJoin} WHERE ${owned} ORDER BY i.due_at,i.id`,
    scope(u),
  )
  const mail = await db.query(
    `SELECT m.id, m.item_id AS "recordId", m.kind AS title,m.summary,m.at FROM cw_mail m
    JOIN cw_items i ON i.id=m.item_id WHERE ${owned} AND m.recipient=$3 ORDER BY m.at DESC,m.id DESC LIMIT 100`,
    scope(u),
  )
  return {
    department: u.department,
    asOf,
    items: rows.map(card),
    mail: mail.rows.map((m) => ({ ...m, at: date(m.at) })),
  }
}
async function receipts(db, id) {
  const { rows } = await db.query(
    `SELECT a.id,a.action,a.at,a.summary,a.payload,a.digest,a.expected_version AS version,
      CASE WHEN f.id IS NOT NULL THEN jsonb_build_object('id',f.id,'system',f.system_name,'title',f.title,
        'fields',f.fields,'sources',f.sources,'at',f.filed_at) END AS destination
      FROM ep_port_actions a LEFT JOIN ep_port_filed_records f ON f.approval_id=a.id
      WHERE a.item_id=$1 ORDER BY a.at DESC,a.id`,
    [id],
  )
  return rows.map((r) => ({ ...r, at: date(r.at) }))
}
async function referrals(db, u, id) {
  const finance = u.department === 'finance'
  const { rows } = await db.query(
    `SELECT f.id,f.state,f.finance_id,f.matter_id,f.disposition,f.reference,f.created_at,m.summary AS delivered_answer,m.at AS delivered_at
     FROM ep_port_referrals f LEFT JOIN cw_mail m ON m.id=f.id||'-reply' AND m.item_id=f.finance_id
     WHERE ${finance ? 'f.finance_id=$1' : "f.matter_id=$1 AND f.state<>'queued'"} ORDER BY f.created_at DESC,f.id`,
    [id],
  )
  return rows.map((row) => ({
    id: row.id,
    recordId: id,
    financeId: row.finance_id,
    matterId: row.matter_id,
    state: finance && row.state === 'reply_queued' ? 'awaiting_legal' : row.state,
    question: requestQuestion,
    createdAt: date(row.created_at),
    ...((!finance || (row.state === 'completed' && row.delivered_answer)) &&
      row.disposition && {
        disposition: row.disposition,
        reference: row.reference,
        answer: finance ? row.delivered_answer : approvedDisposition.text,
      }),
    ...(finance &&
      row.state === 'completed' &&
      row.delivered_answer && { sourceId: 'A2A-' + row.id, deliveredAt: date(row.delivered_at) }),
  }))
}

// Finance owns its delivered mailbox receipt. The matter team's register and notes stay on the legal record.
function deliveryDocument(delivery) {
  return {
    id: delivery.sourceId,
    title: 'Legal billing disposition · ' + delivery.reference,
    kind: 'Approved A2A response',
    version: 1,
    passages: [
      { id: 'disposition', label: 'Approved Legal reply', text: delivery.answer },
      { id: 'receipt', label: 'Delivered to Finance', text: delivery.deliveredAt + ' · ' + delivery.id },
    ],
  }
}

function action(id, label, recipient, preview, sourceIds) {
  return { id, label, recipient, preview, sourceIds }
}
function filedRecord(row, op) {
  if (op === 'approve_packet') {
    const fields = row.contents.chronology.map((event) => {
      const doc = row.contents.sources.find((source) => source.id === event.sourceId)
      const line = doc.passages.find((passage) => passage.id === event.anchorId)
      return { label: event.label, value: line.text, sourceId: doc.id, anchorId: line.id }
    })
    fields.push({
      label: 'Review status',
      value: 'Independent confirmation of the incident date is outstanding.',
    })
    return { title: 'Factual chronology · ' + row.id, fields }
  }
  if (op === 'open_review') {
    const { invoiceCents, stagedCents, varianceCents } = reconcile(row.contents)
    return {
      title: 'Billing review · ' + row.id,
      fields: [
        { label: 'Supplier invoice', value: amount(invoiceCents) },
        { label: 'Staged client bill', value: amount(stagedCents) },
        { label: 'Variance', value: amount(varianceCents) },
        { label: 'Review reason', value: row.reason },
      ],
    }
  }
  return null
}
function available(row, approved, referral) {
  const { id, sources } = row.contents
  const prior = new Set(approved.map((r) => r.action))
  const choices = []
  if (id === 'MAT-017') {
    const reportIds = ['WC-103-report', 'WC-103-shift']
    if (!prior.has('approve_packet'))
      choices.push(
        action(
          'approve_packet',
          'Approve factual packet',
          'Mock legal matter file',
          'File both source excerpts. The supervisor report gives November 9, the handover gives November 10, and independent confirmation is outstanding. Notify the assigned adjuster with the approved references.',
          reportIds,
        ),
      )
    if (!prior.has('request_confirmation'))
      choices.push(
        action(
          'request_confirmation',
          'Request date confirmation',
          'Assigned WC-103 adjuster',
          'Ask the assigned adjuster to confirm the incident date against the supervisor report and shift handover.',
          reportIds,
        ),
      )
    if (referral?.state === 'awaiting_legal')
      choices.push(
        action(
          'reply_finance',
          'Approve reply to Finance',
          'Finance Billing Review',
          approvedDisposition.text + ' Share billing reference ' + approvedDisposition.reference + '.',
          ['AUTH-600-01'],
        ),
      )
  }
  if (row.contents.department === 'finance') {
    if (!prior.has('open_review'))
      choices.push(
        action(
          'open_review',
          'Open billing review',
          'Mock Finance review register',
          'Open an internal review of the ' +
            amount(reconcile(row.contents).varianceCents) +
            ' difference using the listed invoice and staged bill. The staged amounts remain subject to reconciliation.',
          sources.map((s) => s.id),
        ),
      )
    if (id === 'FIN-207' && (!referral || referral.state === 'completed'))
      choices.push(
        action(
          'ask_legal',
          referral ? 'Request another authorization check' : 'Ask Legal to verify expense',
          'Legal Matters · MAT-017',
          requestQuestion,
          ['INV-318', 'FIN-207-staged'],
        ),
      )
  }
  return choices.map((choice) => ({ ...choice, filing: filedRecord(row, choice.id) }))
}
async function detail(db, u, row) {
  const history = await receipts(db, row.id)
  const handoffs = await referrals(db, u, row.id)
  const details = row.contents
  const rec = reconcile(details)
  const sources = [...details.sources, ...handoffs.filter((h) => h.sourceId).map(deliveryDocument)]
  return {
    ...card(row),
    sources,
    sourceVersions: sources.map((source) => [source.id, source.version]),
    chronology: details.chronology || [],
    checklist: details.checklist || [],
    ...(rec && { reconciliation: rec }),
    referral: handoffs[0] || null,
    referrals: handoffs,
    receipts: history,
    actions: available(row, history, handoffs[0]),
  }
}

async function bump(db, id, status, step) {
  await db.query(
    'UPDATE cw_items SET version=version+1,state=COALESCE($2,state),next_action=COALESCE($3,next_action) WHERE id=$1',
    [id, status || null, step || null],
  )
}
async function notify(db, id, item, recipient, kind, summary, source) {
  await db.query(
    'INSERT INTO cw_mail(id,item_id,recipient,kind,summary,source,at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(id) DO NOTHING',
    [id, item, recipient, kind, summary, source],
  )
}

async function peerRecord(db, tenant, id, department) {
  const row = first(
    await db.query(
      `SELECT i.* FROM ${recordJoin}
    JOIN cw_principals u ON (u.tenant,u.profile,u.id)=(i.tenant,i.profile,i.owner_id)
    WHERE i.id=$1 AND i.tenant=$2 AND i.profile=$3 AND u.role=$4`,
      [id, tenant, profiles[department], department],
    ),
  )
  if (!row) fail(409, 'portfolio_destination_unavailable')
  return row
}

async function apply(db, u, row, input) {
  const { action: op, expectedVersion, requestId } = input || {}
  if (Object.keys(input || {}).some((key) => !['action', 'requestId', 'expectedVersion'].includes(key)))
    fail(400, 'invalid_portfolio_action')
  if (
    typeof requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId) ||
    !Number.isSafeInteger(expectedVersion)
  )
    fail(400, 'invalid_portfolio_action')
  const replay = first(
    await db.query(
      'SELECT action,expected_version FROM ep_port_actions WHERE item_id=$1 AND actor=$2 AND subject=$3 AND request_id=$4',
      [row.id, u.id, u.subject, requestId],
    ),
  )
  if (replay) {
    if (replay.action !== op || replay.expected_version !== expectedVersion) fail(409, 'request_id_conflict')
    return detail(db, u, row)
  }
  if (row.version !== expectedVersion) fail(409, 'stale_version')
  const before = await detail(db, u, row)
  const chosen = before.actions.find((a) => a.id === op)
  if (!chosen) fail(409, 'portfolio_action_unavailable')
  const receipt = (op === 'open_review' ? 'REV-' : 'RCPT-') + randomUUID()
  const data = {
    action: op,
    recordId: row.id,
    version: row.version,
    recipient: chosen.recipient,
    preview: chosen.preview,
    sources: chosen.sourceIds.map((id) => ({
      id,
      version: row.contents.sources.find((source) => source.id === id).version,
    })),
  }
  if (chosen.filing) data.filing = chosen.filing
  if (op === 'reply_finance')
    Object.assign(data, {
      taskId: before.referral.id,
      disposition: approvedDisposition.disposition,
      reference: approvedDisposition.reference,
    })
  if (op === 'ask_legal')
    Object.assign(data, {
      taskId: 'HO-' + randomUUID(),
      financeId: row.id,
      matterId: 'MAT-017',
      invoiceRef: 'INV-318',
      expenseRef: 'EXP-044',
      amountCents: 60000,
    })
  const summaries = {
    approve_packet: 'Factual packet filed with the incident date marked unconfirmed.',
    request_confirmation: 'Date confirmation requested from the assigned adjuster.',
    open_review: 'Billing review item opened for the invoice and staged bill.',
    ask_legal: 'Authorization question approved for delivery to Legal.',
    reply_finance: 'Billing disposition approved for delivery to Finance.',
  }
  await db.query(
    `INSERT INTO ep_port_actions(id,item_id,actor,subject,request_id,expected_version,action,payload,digest,summary)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [receipt, row.id, u.id, u.subject, requestId, row.version, op, data, digest(data), summaries[op]],
  )

  if (chosen.filing) {
    const destinationId = (op === 'approve_packet' ? 'PACKET-' : 'BILLREV-') + randomUUID()
    await db.query(
      `INSERT INTO ep_port_filed_records(id,approval_id,system_name,title,fields,sources) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        destinationId,
        receipt,
        data.recipient,
        chosen.filing.title,
        JSON.stringify(chosen.filing.fields),
        JSON.stringify(data.sources),
      ],
    )
  }

  if (op === 'approve_packet' || op === 'request_confirmation') {
    const adjuster = first(
      await db.query(
        "SELECT owner_id FROM cw_items WHERE id='WC-103' AND tenant=$1 AND profile='claims-v1' FOR SHARE",
        [u.tenant],
      ),
    )
    if (!adjuster) fail(409, 'portfolio_destination_unavailable')
    const packet = op === 'approve_packet'
    await notify(
      db,
      receipt,
      'WC-103',
      adjuster.owner_id,
      packet ? 'Legal packet filed' : 'Incident-date confirmation requested',
      (packet
        ? 'Legal filed the factual packet with the incident date marked unconfirmed.'
        : 'Legal requests independent confirmation of the incident date.') +
        ' Approved references: WC-103-report (v1), WC-103-shift (v1).',
      'Legal Matters',
    )
    await bump(
      db,
      row.id,
      packet ? 'Packet approved' : null,
      packet ? 'Review the filed packet and monitor related requests.' : null,
    )
  } else if (op === 'open_review') {
    await bump(db, row.id, 'Review opened', 'Follow up on the recorded billing review.')
  } else if (op === 'ask_legal') {
    await peerRecord(db, u.tenant, data.matterId, 'legal')
    await db.query(
      `INSERT INTO ep_port_referrals(id,finance_id,matter_id,request_receipt,state)
      VALUES($1,$2,$3,$4,'queued')`,
      [data.taskId, row.id, data.matterId, receipt],
    )
    await bump(db, row.id)
  } else {
    await peerRecord(db, u.tenant, before.referral.financeId, 'finance')
    const updated = await db.query(
      `UPDATE ep_port_referrals SET state='reply_queued',reply_receipt=$2,disposition=$3,reference=$4,
      updated_at=clock_timestamp() WHERE id=$1 AND matter_id=$5 AND state='awaiting_legal'`,
      [data.taskId, receipt, data.disposition, data.reference, row.id],
    )
    if (!updated.rowCount) fail(409, 'stale_referral')
    await bump(db, row.id)
  }
  return detail(db, u, await record(db, u, row.id))
}

const workerProjection = `SELECT f.*, qi.payload AS request_payload, ai.payload AS reply_payload,
  bp.contents->'sources' AS finance_sources, mp.contents->'sources' AS matter_sources FROM ep_port_referrals f
  JOIN ep_port_actions qi ON qi.id=f.request_receipt
  JOIN cw_items bi ON bi.id=f.finance_id AND bi.owner_id=qi.actor AND bi.profile='${profiles.finance}'
  JOIN cw_items mi ON mi.id=f.matter_id AND mi.tenant=bi.tenant AND mi.profile='${profiles.legal}'
  JOIN ep_port_records bp ON bp.item_id=bi.id JOIN ep_port_records mp ON mp.item_id=mi.id
  JOIN cw_principals fin ON (fin.tenant,fin.profile,fin.id)=(bi.tenant,bi.profile,bi.owner_id) AND fin.role='finance'
  JOIN cw_principals leg ON (leg.tenant,leg.profile,leg.id)=(mi.tenant,mi.profile,mi.owner_id) AND leg.role='legal'
  LEFT JOIN ep_port_actions ai ON ai.id=f.reply_receipt AND ai.actor=mi.owner_id`

function currentSources(approval, sources) {
  return approval.sources.every((ref) =>
    sources.some((doc) => doc.id === ref.id && doc.version === ref.version),
  )
}
function validDelivery(row) {
  if (
    !row ||
    row.id !== row.request_payload.taskId ||
    row.request_payload.financeId !== row.finance_id ||
    row.request_payload.matterId !== row.matter_id ||
    row.request_payload.action !== 'ask_legal' ||
    !currentSources(row.request_payload, row.finance_sources)
  )
    return false
  if (!['reply_queued', 'completed'].includes(row.state)) return true
  return (
    row.reply_payload?.taskId === row.id &&
    row.reply_payload?.action === 'reply_finance' &&
    row.reply_payload.disposition === row.disposition &&
    row.reply_payload.reference === row.reference &&
    currentSources(row.reply_payload, row.matter_sources)
  )
}
function outgoing(row) {
  const { invoiceRef, expenseRef, amountCents } = row.request_payload
  return {
    id: row.id,
    financeId: row.finance_id,
    matterId: row.matter_id,
    state: row.state,
    invoiceRef,
    expenseRef,
    amountCents,
    ...(row.state === 'reply_queued' && { disposition: row.disposition, reference: row.reference }),
  }
}
async function acceptDelivery(db, id, phase, result) {
  const row = first(await db.query(workerProjection + ' WHERE f.id=$1 FOR UPDATE OF bi,mi,f', [id]))
  if (!validDelivery(row)) fail(409, 'handoff_approval_unavailable')
  if (
    phase === 'reply' &&
    (!result ||
      result.disposition !== row.disposition ||
      result.reference !== row.reference ||
      result.disposition !== approvedDisposition.disposition ||
      result.reference !== approvedDisposition.reference)
  )
    fail(409, 'handoff_result_mismatch')
  if ((phase === 'send' && row.state !== 'queued') || (phase === 'reply' && row.state === 'completed')) return
  const send = phase === 'send'
  if (!send && row.state !== 'reply_queued') fail(409, 'handoff_state_mismatch')
  await db.query('UPDATE ep_port_referrals SET state=$2,updated_at=clock_timestamp() WHERE id=$1', [
    id,
    send ? 'awaiting_legal' : 'completed',
  ])
  const item = send ? row.matter_id : row.finance_id
  const recipient = first(await db.query('SELECT owner_id FROM cw_items WHERE id=$1', [item])).owner_id
  await notify(
    db,
    id + '-' + phase,
    item,
    recipient,
    send ? 'Finance authorization request' : 'Legal authorization reply',
    send ? requestQuestion : approvedDisposition.text + ' Billing reference ' + row.reference + '.',
    send ? 'Finance A2A' : 'Legal A2A',
  )
  for (const itemId of [row.finance_id, row.matter_id]) await bump(db, itemId)
}

const sourceRef = (rec, id, anchorId) => {
  const doc = rec.sources.find((s) => s.id === id)
  return { recordId: rec.id, sourceId: id, anchorId, title: doc.title, version: doc.version }
}
const response = (text, sources = []) => ({ text, sources, mode: 'verified-records' })
const unsupported = () => response('The available records do not establish an answer to that question.')
function answerRecord(rec, question) {
  const q = question.toLowerCase()
  if (
    rec.id === 'MAT-017' &&
    /chronolog|timeline|dates?|packet|verify|evidence|conflict/.test(q) &&
    !/expense|authoriz|amendment/.test(q)
  ) {
    return response(
      'The signed supervisor report places the incident on November 9. The handover gives November 10 and was recorded on November 17. The incident date is unconfirmed. The factual packet can include both accounts and identify the discrepancy.',
      [
        sourceRef(rec, 'WC-103-report', 'account'),
        sourceRef(rec, 'WC-103-shift', 'date'),
        sourceRef(rec, 'WC-103-shift', 'recorded'),
      ],
    )
  }
  if (rec.id === 'MAT-017' && /authoriz|expense|amendment|finance/.test(q)) {
    return response(approvedDisposition.text + ' Billing reference ' + approvedDisposition.reference + '.', [
      sourceRef(rec, 'AUTH-600-01', 'entry'),
    ])
  }
  if (
    rec.department === 'finance' &&
    /authori[sz]|amendment|did legal|legal.*(?:confirm|approv|reply|answer|respond|return)|referral|approved.*expense/.test(
      q,
    )
  ) {
    if (rec.referral?.sourceId)
      return response(rec.referral.answer, [sourceRef(rec, rec.referral.sourceId, 'disposition')])
    if (rec.referral)
      return response(
        'Legal authorization has not been verified for the current request. Its status is ' +
          rec.referral.state.replaceAll('_', ' ') +
          '.',
      )
    return response(
      'No authorization request has been sent. The invoice and staged bill do not establish whether Legal authorized a second expense.',
    )
  }
  if (
    rec.department === 'finance' &&
    /varianc|invoice|expense|differ|bill|explain|reconcil|duplicate/.test(q)
  ) {
    const { invoiceRows, stagedRows, invoiceCents, stagedCents, varianceCents } = rec.reconciliation
    const repeated = stagedRows.filter((row, n) =>
      stagedRows.slice(0, n).some((other) => other.reference === row.reference),
    )
    const why = repeated.length
      ? ' The staged bill includes two ' +
        amount(repeated[0].cents) +
        ' expense lines with reference ' +
        repeated[0].reference +
        '. The repeated reference needs review.'
      : ''
    return response(
      'The supplier invoice totals ' +
        amount(invoiceCents) +
        '. The staged bill totals ' +
        amount(stagedCents) +
        '. Staged minus invoiced is ' +
        amount(varianceCents) +
        '.' +
        why,
      [...invoiceRows, ...stagedRows].map((row) => sourceRef(rec, row.sourceId, row.anchorId)),
    )
  }
  if (/next|what.*need|status|summary|source|outstanding|record|triag/.test(q)) {
    const doc = rec.sources.find((s) => s.id === rec.id + '-request') || rec.sources[0]
    return response(rec.id + ' · ' + rec.status + '. ' + rec.reason + ' ' + rec.nextAction, [
      sourceRef(rec, doc.id, doc.passages[0].id),
    ])
  }
  return unsupported()
}

async function answerPortfolio(db, u, question) {
  if (!/due|week|missing|triage|portfolio|priorit|exception|matter|queue/.test(question.toLowerCase()))
    return unsupported()
  const { rows } = await db.query(
    `SELECT i.*,p.contents FROM ${recordJoin} WHERE ${owned} ORDER BY i.due_at,i.id`,
    scope(u),
  )
  const end = new Date(asOf)
  if (/today|shift/i.test(question)) end.setUTCHours(23, 59, 59, 999)
  else {
    end.setUTCDate(end.getUTCDate() + ((7 - end.getUTCDay()) % 7))
    end.setUTCHours(23, 59, 59, 999)
  }
  const selected = rows.filter((row) => {
    if (/week|today|shift/i.test(question) && new Date(row.due_at) > end) return false
    if (u.department === 'legal' && /missing|outstanding/i.test(question))
      return row.contents.checklist.some((check) => !check.complete)
    return true
  })
  const text = selected.map(
    (row) =>
      row.id +
      ' · ' +
      row.title +
      ' · due ' +
      date(row.due_at).slice(0, 16).replace('T', ' ') +
      ' UTC. ' +
      row.reason,
  )
  return response(
    text.length ? text.join('\n') : 'No records matched in this portfolio.',
    selected.map((row) => {
      const document = row.contents.sources.find((s) => s.id === 'REQ-017') || row.contents.sources[0]
      return sourceRef(row.contents, document.id, document.passages[0].id)
    }),
  )
}

/** Synthetic Legal and Finance records share the claims identity, item and mailbox tables. */
export function createPortfolioStore(pool) {
  return {
    async seed() {
      await transaction(pool, async (db) => {
        await db.query('SELECT pg_advisory_xact_lock(72735108)')
        for (const [department, profile] of Object.entries(profiles)) {
          await db.query(
            'INSERT INTO cw_principals(tenant,profile,id,role) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',
            ['demo', profile, department],
          )
        }
        for (const fixture of records) {
          const data = [
            fixture.id,
            'demo',
            profiles[fixture.department],
            fixture.owner,
            fixture.department === 'legal' ? 'matter' : 'billing_exception',
            fixture.title,
            fixture.status,
            fixture.reason,
            fixture.nextAction,
            fixture.dueAt,
            asOf,
            departmentProfiles[fixture.department].name,
          ]
          await db.query(
            `INSERT INTO cw_items(id,tenant,profile,owner_id,type,title,state,reason,next_action,due_at,as_of,source)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
            data,
          )
          await db.query(
            'INSERT INTO ep_port_records(item_id,contents) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
            [fixture.id, fixture],
          )
        }
      })
    },
    async bootstrap(ctx) {
      const u = await employee(pool, ctx, false)
      return u ? { department: u.department, name: departmentProfiles[u.department].name } : null
    },
    list: (ctx) => transaction(pool, async (db) => list(db, await employee(db, ctx)), true),
    detail: (ctx, id) =>
      transaction(
        pool,
        async (db) => {
          const u = await employee(db, ctx)
          return detail(db, u, await record(db, u, id))
        },
        true,
      ),
    source: (ctx, id, sourceId) =>
      transaction(
        pool,
        async (db) => {
          const u = await employee(db, ctx)
          const row = await record(db, u, id)
          const original = row.contents.sources.find((doc) => doc.id === sourceId)
          if (original) return original
          if (u.department === 'finance' && typeof sourceId === 'string' && sourceId.startsWith('A2A-')) {
            const delivery = (await referrals(db, u, id)).find((h) => h.sourceId === sourceId)
            if (delivery) return deliveryDocument(delivery)
          }
          fail(404, 'not_found')
        },
        true,
      ),
    act: (ctx, id, input) =>
      transaction(pool, async (db) => {
        const u = await employee(db, ctx)
        return apply(db, u, await record(db, u, id, true), input)
      }),
    ask: (ctx, id, question) =>
      transaction(
        pool,
        async (db) => {
          const u = await employee(db, ctx)
          if (typeof question !== 'string' || !question.trim() || question.length > 2000)
            fail(400, 'invalid_question')
          return id == null
            ? answerPortfolio(db, u, question)
            : answerRecord(await detail(db, u, await record(db, u, id)), question)
        },
        true,
      ),
    async pendingHandoffs() {
      const { rows } = await pool.query(
        workerProjection + " WHERE f.state IN ('queued','reply_queued') ORDER BY f.updated_at,f.id",
      )
      return rows.filter(validDelivery).slice(0, 50).map(outgoing)
    },
    noteHandoffSent: (id) => transaction(pool, (db) => acceptDelivery(db, id, 'send')),
    finishHandoff: (id, result) => transaction(pool, (db) => acceptDelivery(db, id, 'reply', result)),
  }
}
