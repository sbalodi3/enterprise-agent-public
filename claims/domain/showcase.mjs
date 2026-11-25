import { dailyActions, permitsAction, validHandlingCommand } from './handling-actions.mjs'
import { wageDisclosure, wageCases, employmentSupplement } from '../showcase/data/wage-cases.mjs'
import { supervisesClaims } from './claim-access.mjs'
import { randomUUID } from 'node:crypto'
import { showcaseCapabilities } from './showcase-capabilities.mjs'
import { seedCmsDataset } from '../showcase/cms-mcp/import.mjs'
import { PROFILE, seedPrincipals } from './fixtures.mjs'

const first = (result) => result.rows[0]
async function saveDocument(db, doc, source) {
  await db.query(
    'INSERT INTO cw_evidence(id,item_id,source,title,body,as_of,document) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [doc.id, doc.itemId, source, doc.title, doc.anchors.map((a) => a.text).join('\n'), doc.asOf, doc],
  )
}

async function insertItem(db, data, type, documents) {
  const row = first(
    await db.query(
      `INSERT INTO cw_items(id,tenant,profile,owner_id,type,title,state,reason,next_action,due_at,as_of,source,lifecycle)
     VALUES($1,'demo','claims-v1',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
      [
        data.id,
        data.ownerId,
        type,
        data.title,
        data.state,
        data.reason,
        data.nextAction,
        data.dueAt,
        data.asOf,
        data.source,
        data.lifecycle ?? 'open',
      ],
    ),
  )
  if (!row) return
  const { claimant, employer, site, jurisdiction, incidentDate, candidateIds = [] } = data
  await db.query('INSERT INTO cw_showcase_records(item_id,facts) VALUES($1,$2)', [
    row.id,
    { claimant, employer, site, jurisdiction, incidentDate, candidateIds },
  ])
  for (const id of data.documents) {
    const { getDocument } = await import('../showcase/data/documents.mjs')
    const doc = documents?.find(d => d.id === id) ?? getDocument(id)
    if (!doc || doc.itemId !== row.id) throw new Error('invalid_scenario_document')
    await saveDocument(db, doc, doc.source ?? data.source)
    await db.query(
      `INSERT INTO cw_events(id,item_id,kind,summary,at,source,evidence_id,anchor_id)
       VALUES($1,$2,'document.received',$3,$4,$5,$6,$7)`,
      [
        'received-' + id,
        row.id,
        doc.title,
        doc.asOf,
        doc.source ?? data.source,
        id,
        doc.anchors[0]?.id ?? null,
      ],
    )
  }
  if (type === 'intake') {
    await db.query(
      `INSERT INTO cw_mail(id,item_id,recipient,kind,summary,source,at,obligation_event,evidence_id)
       VALUES($1,$2,$3,'review',$4,$5,$6,$7,$8)`,
      [
        'call-' + data.id,
        row.id,
        row.owner_id,
        data.reason,
        data.source,
        data.asOf,
        'voice-' + row.id,
        data.documents[0],
      ],
    )
  }
  return row
}

/** Insert the optional, synthetic study cohort in the caller's transaction. */
export async function seedWageStudy(db) {
  const { studyCases } = await import('../showcase/wage-study/cases.mjs')
  for (const item of studyCases) {
    await insertItem(db, item, 'claim', item.records)
    const row = first(await db.query('SELECT tenant,source FROM cw_items WHERE id=$1', [item.id]))
    if (row?.source !== 'Wage evidence study' || row.tenant !== 'demo') throw Error('Study claim ID is already in use')
  }
}

/** Idempotent seed for an isolated showcase database. The first missed call is delivered on cue. */
export async function seedShowcase(db, cmsSnapshot = null) {
  if (
    first(
      await db.query(
        'SELECT 1 FROM cw_items i LEFT JOIN cw_showcase_records s ON i.id=s.item_id WHERE i.profile=$1 AND s.item_id IS NULL LIMIT 1',
        [PROFILE],
      ),
    )
  )
    throw new Error('showcase_requires_isolated_database')
  const { claims, intakes } = await import('../showcase/data/scenario.mjs')
  await seedPrincipals(db)
  for (const claim of claims) await insertItem(db, claim, 'claim')
  for (const intake of intakes.filter((item) => item.id !== 'IN-201')) await insertItem(db, intake, 'intake')
  await seedCmsDataset(db, cmsSnapshot)
  if (cmsSnapshot) for (const id of ['CLM-000020','CLM-000002']) {
    const doc = employmentSupplement(id)
    if (!(await db.query('SELECT 1 FROM cw_evidence WHERE id=$1',[doc.id])).rowCount) await saveDocument(db,doc,doc.source)
  }
}

const selectSource = (db, itemId, id) =>
  db
    .query(
      "SELECT document - 'verification' AS document FROM cw_evidence WHERE item_id=$1 AND id=$2 AND document IS NOT NULL",
      [itemId, id],
    )
    .then((result) => first(result)?.document)

export function showcaseDomain({
  pool,
  juris,
  partner,
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
}) {
  const requireEntry = async (db, id) => {
    const record = first(await db.query('SELECT * FROM cw_showcase_records WHERE item_id=$1', [id]))
    if (!record) fail(404, 'not_found')
    return record
  }
  async function assertAvailable(db, id) {
    const unresolved = await db.query(
      `SELECT 1 FROM cw_juris_intents j JOIN cw_operations o ON o.id=j.operation_id
       WHERE o.state='unknown' AND ($1=o.item_id OR $1=j.claim_id) LIMIT 1`,
      [id],
    )
    if (unresolved.rowCount) fail(409, 'awaiting_destination_receipt')
  }
  async function lockedPair(db, u, source, target) {
    const result = new Map()
    for (const id of [...new Set([source, target])].sort()) result.set(id, await visible(db, u, id, true))
    return [result.get(source), result.get(target)]
  }
  async function stage(
    db,
    item,
    target,
    record,
    document,
    anchorId,
    action,
    actor,
    requestId,
    lost,
    artifactDigest,
  ) {
    const anchor = document?.anchors.find((a) => a.id === anchorId)
    if (!anchor || document.itemId !== item.id) fail(400, 'invalid_citation')
    if (record?.id !== target.id || !Number.isInteger(record.revision) || record.revision < 1)
      fail(502, 'invalid_juris_record')
    const payload = {
      action,
      workItemId: item.id,
      version: item.version,
      ownerId: item.owner_id,
      profileId: item.profile,
      commandType: action,
      claimId: target.id,
      targetVersion: target.version,
      targetOwnerId: target.owner_id,
      expectedRevision: record.revision,
      evidenceId: document.id,
      documentId: document.id,
      documentVersion: document.version,
      anchorId,
      quote: anchor.text,
      ...(requestId && { requestId, artifactDigest }),
      field: action === 'record_wage_evidence' ? 'wageEvidence' : 'intakeTranscripts',
      ...(action === 'record_wage_evidence' && item.external_claim_number && {
        filing:document.anchors.filter(a=>a.id!=='scope').map(a=>a.text)}),
      previousValue:
        action === 'record_wage_evidence'
          ? (record.wageEvidence?.quote ?? null)
          : (record.intakeTranscripts ?? []).length,
      proposedValue: anchor.text,
    }
    const p = first(
      await db.query(
        `INSERT INTO cw_proposals(id,item_id,version,action,status,payload,digest,creator,simulate_lost_ack,request_id)
       VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9) RETURNING *`,
        [randomUUID(), item.id, item.version, action, payload, digest(payload), actor.id, lost, requestId],
      ),
    )
    await addEvent(
      db,
      item.id,
      'proposal.prepared',
      'Review prepared for mock JURIS',
      action,
      actor,
      document.id,
      anchorId,
    )
    return proposalView(p)
  }
  async function document(ctx, itemId, id) {
    return run(ctx, async (db, u) => {
      await visible(db, u, itemId)
      const doc = await selectSource(db, itemId, id)
      if (!doc) fail(404, 'not_found')
      return doc
    })
  }
  async function sourceRecord(ctx, id) {
    async function check() {
      await run(ctx, async (db, u) => {
        const i = await visible(db, u, id)
        if (!showcaseCapabilities(i).juris) fail(404, 'not_found')
        await requireEntry(db, id)
      })
    }
    await check()
    const record = await juris.read(id)
    if (record?.id !== id) fail(502, 'invalid_juris_record')
    await check()
    return record
  }
  async function detail(db, u, item) {
    const { facts, filed_claim_id } = await requireEntry(db, item.id)
    const { candidateIds, ...publicFacts } = facts
    const candidates = []
    for (const id of candidateIds) {
      try {
        const target = await visible(db, u, id)
        if (target.owner_id !== u.id && !supervisesClaims(u.role)) continue
        const {
          facts: { candidateIds: _, ...info },
        } = await requireEntry(db, id)
        candidates.push({ id, title: target.title, version: target.version, ...info })
      } catch (e) {
        if (e.code !== 'not_found') throw e
      }
    }
    const docs = (
      await db.query(
        "SELECT document - 'verification' AS document FROM cw_evidence WHERE item_id=$1 AND document IS NOT NULL ORDER BY as_of,id",
        [item.id],
      )
    ).rows.map((r) => r.document)
    const latest = first(
      await db.query(
        'SELECT * FROM cw_wages WHERE item_id=$1 ORDER BY started_version DESC,request_id DESC LIMIT 1',
        [item.id],
      ),
    )
    const filedClaimId =
      filed_claim_id && candidates.some((c) => c.id === filed_claim_id) ? filed_claim_id : null
    return {
      ...publicFacts,
      capabilities: showcaseCapabilities(item),
      documents: docs,
      candidates,
      filed: Boolean(filed_claim_id),
      filedClaimId,
      wage: latest ? wageView(latest) : null,
    }
  }


  async function wageBusy(db, id, replacing = null) {
    const result = await db.query(`SELECT 1 FROM cw_wages WHERE item_id=$1 AND state IN
      ('send-queued','awaiting-partner','awaiting-review','approved','unknown')
      UNION ALL SELECT 1 FROM cw_proposals WHERE item_id=$1 AND action='request_wages'
      AND status='pending' AND id IS DISTINCT FROM $2 LIMIT 1`, [id,replacing])
    return result.rowCount > 0
  }
  async function availableActions(ctx,id) {
    const record = await sourceRecord(ctx,id)
    return run(ctx,async (db,u) => {
      const item = await visible(db,u,id)
      const writable = item.owner_id === u.id || supervisesClaims(u.role)
      const actions = writable && item.external_claim_number ? dailyActions.filter(action =>
        permitsAction(item,action) && (!['reschedule_diary','complete_diary'].includes(action) ||
        record.diaries.some(d => d.status === 'Open'))) : []
      if (writable && showcaseCapabilities(item).wageRequest && !await wageBusy(db,id)) actions.push('request_wages')
      const pending = await db.query(`SELECT p.*,o.id AS operation_id,o.state AS operation_state,o.receipt_id
        FROM cw_proposals p LEFT JOIN cw_operations o ON o.proposal_id=p.id WHERE p.item_id=$1
        AND (p.payload->>'privateTo' IS NULL OR p.payload->>'privateTo'=$2 OR o.state='confirmed')
        ORDER BY p.version DESC,p.id`,[id,u.id])
      const wages = await db.query('SELECT * FROM cw_wages WHERE item_id=$1 ORDER BY started_version DESC',[id])
      return {claimId:id,version:item.version,owner:item.owner_id,finalized:item.lifecycle==='closed',canAct:writable,
        actions,record,reviews:pending.rows.map(p => ({...proposalView(p),operationId:p.operation_id,
          operationState:p.operation_state,receiptId:p.receipt_id})),wages:wages.rows.map(wageView)}
    })
  }
  async function prepareHandling(ctx,id,b) {
    const record = await sourceRecord(ctx,id)
    return run(ctx,async (db,u) => {
      const item = await visible(db,u,id,true)
      canAct(u,item)
      demand(item.version,b.expectedVersion)
      await assertAvailable(db,id)
      let previous
      if (b.replaces) {
        previous = first(await db.query('SELECT * FROM cw_proposals WHERE id=$1 AND item_id=$2 FOR UPDATE',[b.replaces,id]))
        if (previous?.status !== 'pending' || previous.action !== b.action ||
          previous.payload.privateTo && previous.payload.privateTo !== u.id) fail(409,'proposal_closed')
        await db.query("UPDATE cw_proposals SET status='superseded' WHERE id=$1",[previous.id])
      }
      const action = b.action
      let value = { ...b.values }
      let before = null, source = 'Adjuster entry', document
      let requestId
      if (action === 'request_wages') {
        if (!showcaseCapabilities(item).wageRequest) fail(400,'wage_ineligible')
        if (await wageBusy(db,id)) fail(409,'wage_already_open')
        requestId = previous?.payload.requestId ?? b.requestId ?? randomUUID()
        if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,95}$/.test(requestId)) fail(400,'invalid_request_id')
        if ((await db.query('SELECT 1 FROM cw_wages WHERE request_id=$1',[requestId])).rowCount) fail(409,'request_id_conflict')
        value = wageDisclosure(id,u.id)
        document = await selectSource(db,id,id+(item.external_claim_number ? '-employment' : '-report'))
        if (!value || !document) fail(409,'missing_wage_identity')
        source = document.title
      } else {
        if (!item.external_claim_number || !dailyActions.includes(action)) fail(400,'unsupported_action')
        if (!permitsAction(item,action,value.category)) fail(403,'action_unavailable')
        if (b.documentId) {
          document = await selectSource(db,id,b.documentId)
          if (!document || !document.anchors.some(a => a.id === b.anchorId)) fail(400,'invalid_citation')
          if (b.sourceVersion && b.sourceVersion!==document.version || b.sourceClaimVersion && b.sourceClaimVersion!==item.version) fail(409,'stale_citation')
          source = document.title
        }
        if (action === 'add_note') {
          if (b.mailSummary === true) {
            if (previous?.payload.source!=='Outlook email summary') {
              const ref=b.mailRef
              if (!ref || !/^[a-f0-9-]{36}$/.test(ref.turnId)) fail(400,'invalid_mail_reference')
              const found=await db.query(`SELECT 1 FROM cw_mail_turns WHERE tenant=$1 AND actor=$2 AND subject=$3
                AND session_id=$4 AND request_id=$5 AND state='completed' AND answer->>'kind'='read'`,
                [u.tenant,u.id,u.subject,ref.session,ref.turnId])
              if (!found.rowCount) fail(403,'private_mail_reference')
            }
            source='Outlook email summary'
          }
          value.source=source
        }
        if (action === 'create_diary') value.owner=item.owner_id
        if (!validHandlingCommand(action,value)) fail(400,'invalid_action_fields')
        if (action === 'update_field') before = record[value.field]
        if (value.diaryId) {
          before = record.diaries.find(d => d.id === value.diaryId && d.status === 'Open')
          if (!before) fail(409,'diary_closed')
        }
      }
      const anchor = document && (action === 'request_wages' ? document.anchors.at(-1) : document.anchors.find(a => a.id === b.anchorId))
      const payload = {action,workItemId:id,claimId:id,commandType:action,version:item.version,ownerId:item.owner_id,
        profileId:item.profile,targetOwnerId:item.owner_id,targetVersion:item.version,expectedRevision:record.revision,
        destination:action==='request_wages'?'Amazon wage mock':'Mock Juris',previousValue:before,values:value,source,
        ...(document && {evidenceId:document.id,documentId:document.id,documentVersion:document.version,anchorId:anchor.id,quote:anchor.text}),
        ...(requestId && {requestId}),...(previous && {replaces:previous.id}),
        ...(b.mailSummary === true && !b.shareSummary && {privateTo:u.id})}
      const p = first(await db.query(`INSERT INTO cw_proposals(id,item_id,version,action,status,payload,digest,creator,simulate_lost_ack)
        VALUES($1,$2,$3,$4,'pending',$5,$6,$7,false) RETURNING *`,[randomUUID(),id,item.version,action,payload,digest(payload),u.id]))
      await addEvent(db,id,'proposal.prepared','Prepared '+action.replaceAll('_',' '),'Workbench',u)
      return proposalView(p)
    })
  }

  async function prepare(ctx, id, b) {
    if (dailyActions.includes(b.action) || b.action === 'request_wages') return prepareHandling(ctx,id,b)
    if (b.action !== 'file_intake_transcript' || typeof b.targetClaimId !== 'string')
      fail(400, 'unsupported_action')
    const check = async (db, u) => {
      const [item, target] = await lockedPair(db, u, id, b.targetClaimId)
      canAct(u, item)
      canAct(u, target)
      demand(item.version, b.expectedVersion)
      const source = await requireEntry(db, item.id)
      if (item.type !== 'intake' || !showcaseCapabilities(target).intakeTarget || !source.facts.candidateIds.includes(target.id))
        fail(400, 'invalid_match')
      if (source.filed_claim_id) fail(409, 'intake_already_filed')
      const doc = await selectSource(db, id, b.evidenceId)
      if (!doc || doc.id !== 'IN-201-call') fail(400, 'invalid_citation')
      return { item, target, doc }
    }
    await run(ctx, check)
    const record = await sourceRecord(ctx, b.targetClaimId)
    return run(ctx, async (db, u) => {
      const { item, target, doc } = await check(db, u)
      return stage(
        db,
        item,
        target,
        record,
        doc,
        b.anchorId,
        'file_intake_transcript',
        u,
        null,
        b.simulateLostAck === true,
      )
    })
  }
  // JSONB stores the authorized adapter's packet with the immutable source. The presentation reads
  // subtract this field; approvals and commands bind its canonical SHA-256 digest.
  async function packetMatches(db, p) {
    if (!p.request_id) return true
    const record = first(
      await db.query(
        "SELECT document->'verification' AS packet FROM cw_evidence WHERE item_id=$1 AND id=$2",
        [p.item_id, p.payload.documentId],
      ),
    )
    return Boolean(record?.packet && digest(record.packet) === p.payload.artifactDigest)
  }
  async function checkReview(db, u, item, p) {
    if (p.payload.privateTo && p.payload.privateTo !== u.id) fail(403,'private_draft')
    if (!permitsAction(item,p.action,p.payload.values?.category)) fail(403,'action_unavailable')
    if (p.digest !== digest(p.payload)) fail(409,'stale_proposal')
    if ((dailyActions.includes(p.action) || p.action==='request_wages') && (await juris.read(item.id)).revision !== p.payload.expectedRevision) fail(409,'stale_revision')
    if (!(await packetMatches(db, p))) fail(409, 'stale_evidence_packet')
    if (!p.payload.commandType) fail(409, 'invalid_showcase_proposal')
    const target = await visible(db, u, p.payload.claimId, true)
    canAct(u, target)
    if (target.version !== p.payload.targetVersion || target.owner_id !== p.payload.targetOwnerId)
      fail(409, 'stale_version')
    await assertAvailable(db, item.id)
    await assertAvailable(db, target.id)
    if (!p.payload.documentId && dailyActions.includes(p.action)) return
    const source = await selectSource(db, item.id, p.payload.documentId)
    if (
      source?.version !== p.payload.documentVersion ||
      !source.anchors.some((a) => a.id === p.payload.anchorId && a.text === p.payload.quote)
    )
      fail(409, 'stale_citation')
  }
  async function updateReviewState(db, item, p, decision) {
    if (p.action === 'request_wages') {
      if (decision === 'approve') {
        if (await wageBusy(db,item.id,p.id)) fail(409,'wage_already_open')
        await db.query(`INSERT INTO cw_wages(request_id,item_id,state,owner_id,started_version,requested_by,send_proposal_id,approved_input)
          VALUES($1,$2,'send-queued',$3,$4,$5,$6,$7)`,[p.payload.requestId,item.id,item.owner_id,item.version,p.reviewer ?? p.creator,p.id,p.payload.values])
      }
      return
    }
    if (dailyActions.includes(p.action)) return
    if (decision === 'approve') {
      await db.query(
        "UPDATE cw_items SET state='waiting',reason='Approved change queued for mock JURIS',next_action='Verify destination receipt' WHERE id=$1",
        [item.id],
      )
    } else if (p.request_id) {
      await db.query(
        "UPDATE cw_items SET state='ready',reason='Wage evidence review rejected',next_action='Follow up on wage evidence' WHERE id=$1",
        [item.id],
      )
    }
  }
  function commandFor(p, operationId) {
    const b = p.payload
    const payload = {
      ...(b.commandType === 'file_intake_transcript'
        ? { intakeId: b.workItemId }
        : { requestId: b.requestId, artifactDigest: b.artifactDigest }),
      documentId: b.documentId,
      anchorId: b.anchorId,
      quote: b.quote,
      ...(b.filing && {filing:b.filing}),
    }
    return {
      operationId,
      claimId: b.claimId,
      expectedRevision: b.expectedRevision,
      type: b.commandType,
      payload:b.values ?? payload,
      payloadDigest: p.digest,
      ...(p.action==='request_wages' && {requestId:b.requestId,actorId:p.reviewer}),
    }
  }
  async function saveIntent(db, p, o) {
    await db.query('INSERT INTO cw_juris_intents(operation_id,claim_id,command) VALUES($1,$2,$3)', [
      o.id,
      p.payload.claimId,
      commandFor(p, o.id),
    ])
  }
  // The adapter reserves a request before transmission. A missing registration for a legacy
  // request permits a fresh, employee-reviewed proposal. A transport failure keeps it open.
  async function closeUnregisteredWage({requestId,workItemId}) {
    return transaction(pool,async db=>{
      const item=first(await db.query('SELECT * FROM cw_items WHERE id=$1 FOR UPDATE',[workItemId]))
      const row=await wage(db,requestId,true)
      if (!item || row.item_id!==workItemId || row.send_proposal_id) fail(409,'wrong_partner_task')
      if (row.state!=='awaiting-partner' || row.partner_task_id) return wageView(row)
      const closed=first(await db.query("UPDATE cw_wages SET state='stale' WHERE request_id=$1 RETURNING *",[requestId]))
      await db.query("UPDATE cw_items SET state='ready',reason='No partner registration found',next_action='Review a new wage request' WHERE id=$1",[item.id])
      await addEvent(db,item.id,'wage.unregistered','Previous wage request has no partner registration','Amazon wage mock')
      return wageView(closed)
    })
  }
  async function bindPartnerTask({ requestId, workItemId, taskId, contextId }) {
    if (typeof taskId !== 'string' || !taskId || taskId.length > 200) fail(400, 'invalid_partner_task')
    return transaction(pool, async (db) => {
      const w = await wage(db, requestId, true)
      if (
        w.item_id !== workItemId ||
        (w.partner_task_id && w.partner_task_id !== taskId) ||
        (w.partner_context_id && contextId && w.partner_context_id !== contextId)
      )
        fail(409, 'wrong_partner_task')
      if (w.state !== 'awaiting-partner' && !w.partner_task_id) fail(409, 'wage_closed')
      const { rows } = await db.query(
        'UPDATE cw_wages SET partner_task_id=$2,partner_context_id=COALESCE(partner_context_id,$3) WHERE request_id=$1 RETURNING *',
        [requestId, taskId, contextId ?? null],
      )
      return wageView(rows[0])
    })
  }
  async function admitPartnerNotice({ requestId, workItemId, eventId, taskId, contextId }) {
    return transaction(pool, async (db) => {
      const w = await wage(db, requestId, true)
      if (
        w.item_id !== workItemId ||
        w.partner_task_id !== taskId ||
        (w.partner_context_id && w.partner_context_id !== contextId) ||
        eventId !== 'wage-result:' + taskId
      )
        fail(409, 'wrong_partner_task')
      const existing = first(
        await db.query('SELECT * FROM cw_partner_notices WHERE request_id=$1', [requestId]),
      )
      if (
        existing?.event_id === eventId &&
        existing.task_id === taskId &&
        !['stale', 'timed-out'].includes(w.state)
      )
        return { eventId, duplicate: true }
      if (existing || w.state !== 'awaiting-partner') fail(409, 'wage_closed')
      await db.query('INSERT INTO cw_partner_notices(event_id,request_id,task_id) VALUES($1,$2,$3)', [
        eventId,
        requestId,
        taskId,
      ])
      await enqueueWage(db, requestId, 'evidence', eventId)
      return { eventId, duplicate: false }
    })
  }
  async function acceptWage({
    requestId,
    workItemId,
    eventId,
    taskId,
    contextId,
    artifact,
    signedResponseHash,
  }) {
    const w = await wage(pool, requestId)
    if (
      w.item_id !== workItemId ||
      !taskId ||
      w.partner_task_id !== taskId ||
      (w.partner_context_id && w.partner_context_id !== contextId)
    )
      fail(409, 'wrong_partner_task')
    if (w.event_id === eventId && w.artifact_id) return wageView(w)
    const wageSource = artifact?.provenance
    if (
      w.state !== 'awaiting-partner' ||
      artifact?.schema !== 'query.wage_evidence/1.0.0/output' ||
      !/^sha256:[a-f0-9]{64}$/.test(signedResponseHash) ||
      !/^sha256:[a-f0-9]{64}$/.test(wageSource?.payloadHash) ||
      !wageSource?.policyDecisionId
    )
      fail(409, 'unverified_partner_event')
    const record = await juris.read(w.item_id)
    return transaction(pool, async (db) => {
      const item = first(await db.query('SELECT * FROM cw_items WHERE id=$1 FOR UPDATE', [w.item_id]))
      const current = await wage(db, requestId, true)
      if (current.event_id === eventId && current.artifact_id) return wageView(current)
      const binding = first(
        await db.query('SELECT * FROM cw_partner_notices WHERE request_id=$1', [requestId]),
      )
      if (
        current.state !== 'awaiting-partner' ||
        item.owner_id !== w.owner_id ||
        binding?.event_id !== eventId ||
        binding?.task_id !== taskId
      )
        fail(409, 'unverified_partner_event')
      const { buildWageDocument } = await import('../showcase/data/documents.mjs')
      const interval = current.approved_input ?? wageCases[item.id]
      const doc = buildWageDocument(item.id, { requestId, artifact, periodStart:interval?.dateRangeStart, periodEnd:interval?.dateRangeEnd })
      const packet = {
        requestId,
        workItemId,
        eventId,
        taskId,
        contextId: contextId ?? null,
        signedResponseHash,
        artifact,
      }
      await saveDocument(db, { ...doc, verification: packet }, 'Partner wage service')
      await addEvent(
        db,
        item.id,
        'wage.evidence',
        'Partner wage statement received',
        'Partner wage service',
        null,
        doc.id,
        'period-1',
      )
      const id = await mail(db, item, 'review', 'Wage statement ready for review', 'Partner wage service')
      await db.query('UPDATE cw_mail SET obligation_event=$2,evidence_id=$3 WHERE id=$1', [
        id,
        eventId,
        doc.id,
      ])
      const changed = first(
        await db.query(
          `UPDATE cw_items SET state='review',reason='Partner returned wage evidence',next_action='Review wage statement',
         source='Partner wage service',version=version+1 WHERE id=$1 RETURNING *`,
          [item.id],
        ),
      )
      await expireReviews(db, item.id)
      await stage(
        db,
        changed,
        changed,
        record,
        doc,
        item.external_claim_number ? 'coverage' : 'period-1',
        'record_wage_evidence',
        { id: 'wage-service' },
        requestId,
        false,
        digest(packet),
      )
      return wageView(
        first(
          await db.query(
            "UPDATE cw_wages SET state='awaiting-review',event_id=$2,artifact_id=$3 WHERE request_id=$1 RETURNING *",
            [requestId, eventId, doc.id],
          ),
        ),
      )
    })
  }
  async function dispatch({ operationId, simulateLostAck }, reconcile) {
    // Reserve the approved command in one transaction, then release all locks before calling JURIS.
    async function withIntent(fn) {
      return transaction(pool, async (db) => {
        const j = first(await db.query('SELECT * FROM cw_juris_intents WHERE operation_id=$1', [operationId]))
        if (!j) fail(404, 'not_found')
        const linked = first(await db.query('SELECT item_id FROM cw_operations WHERE id=$1', [operationId]))
        const items = (
          await db.query('SELECT * FROM cw_items WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [
            [linked.item_id, j.claim_id],
          ])
        ).rows
        const o = first(await db.query('SELECT * FROM cw_operations WHERE id=$1 FOR UPDATE', [operationId]))
        const p = first(await db.query('SELECT * FROM cw_proposals WHERE id=$1', [o.proposal_id]))
        const item = items.find((i) => i.id === o.item_id),
          target = items.find((i) => i.id === j.claim_id)
        async function setState(state, receiptId = null) {
          const updated = first(
            await db.query('UPDATE cw_operations SET state=$2,receipt_id=$3 WHERE id=$1 RETURNING *', [
              o.id,
              state,
              receiptId,
            ]),
          )
          if (p.request_id)
            await db.query('UPDATE cw_wages SET state=$2 WHERE request_id=$1', [p.request_id, state])
          if (p.action === 'request_wages' && ['unknown','stale'].includes(state)) await db.query('UPDATE cw_wages SET state=$2 WHERE send_proposal_id=$1',[p.id,state])
          if (state === 'stale' && item.state === 'waiting' && (p.request_id || p.action==='file_intake_transcript')) {
            await db.query(
              "UPDATE cw_items SET state='ready',reason='Reviewed change needs attention',next_action=$2 WHERE id=$1",
              [item.id, p.request_id ? 'Request fresh wage evidence' : 'Review the intake match'],
            )
          }
          return opView({ ...updated, request_id: p.request_id })
        }
        return fn({ db, j, o, p, item, target, setState })
      })
    }
    const admitted = await withIntent(async ({ db, j, o, p, item, target, setState }) => {
      if (reconcile ? o.state !== 'unknown' : o.state !== 'queued') return { result: opView(o) }
      const expected = commandFor(p, o.id)
      if (
        o.attestation.payloadHash !== p.digest ||
        digest(p.payload) !== p.digest ||
        digest(j.command) !== digest(expected)
      ) {
        return { result: reconcile ? opView(o) : await setState('stale') }
      }
      if (!reconcile) {
        const datasetActive = !item.external_claim_number || (await db.query("SELECT 1 FROM cw_datasets WHERE id='cms-mcp' AND active FOR SHARE")).rowCount > 0
        const actor = first(
          await db.query('SELECT * FROM cw_principals WHERE id=$1 AND tenant=$2 AND profile=$3', [
            p.reviewer,
            item.tenant,
            item.profile,
          ]),
        )
        const check =
          actor && datasetActive && permitsAction(target,p.action,p.payload.values?.category) &&
          p.status === 'approved' &&
          o.attestation.principalId === actor.id &&
          o.expected_version === item.version &&
          p.payload.ownerId === item.owner_id &&
          p.payload.targetVersion === target.version &&
          p.payload.targetOwnerId === target.owner_id &&
          (supervisesClaims(actor.role) || (actor.id === item.owner_id && actor.id === target.owner_id))
        if (!check || !(await packetMatches(db, p))) return { result: await setState('stale') }
        const conflicting = first(
          await db.query(
            `SELECT 1 FROM cw_juris_intents other JOIN cw_operations op ON op.id=other.operation_id
           WHERE op.state='unknown' AND (op.item_id=ANY($1::text[]) OR other.claim_id=ANY($1::text[]))`,
            [[item.id, target.id]],
          ),
        )
        if (conflicting) return { result: await setState('stale') }
        await setState('unknown')
      }
      return { command: j.command, loseResponse: !reconcile && (simulateLostAck || p.simulate_lost_ack) }
    })
    if (admitted.result) return admitted.result
    const sendWage = admitted.command.type === 'request_wages'
    let record
    let receipt,
      conflict = false
    try {
      if (sendWage) {
        if (!reconcile && (await juris.read(admitted.command.claimId)).revision !== admitted.command.expectedRevision) {
          conflict = true
        } else receipt = await partner(admitted.command,reconcile)
      } else {
        receipt = reconcile ? await juris.receipt(operationId) : await juris.apply(admitted.command)
        if (receipt && dailyActions.includes(admitted.command.type)) record = await juris.read(admitted.command.claimId)
      }
      if (admitted.loseResponse) receipt = null
    } catch (error) {
      conflict =
        !reconcile && error.status === 409 && ['stale_revision', 'operation_conflict'].includes(error.code)
    }
    return withIntent(async ({ db, o, p, item, target, setState }) => {
      if (o.state !== 'unknown') return opView(o)
      if (conflict) {
        await db.query(
          "UPDATE cw_items SET state='ready',reason='Destination revision changed',next_action='Prepare a new review' WHERE id=$1",
          [item.id],
        )
        await addEvent(db, item.id, 'operation.stale', 'Mock JURIS requires a fresh review', 'Mock JURIS')
        return setState('stale')
      }
      const command = admitted.command
      if (
        !receipt ||
        receipt.operationId !== o.id ||
        receipt.claimId !== target.id ||
        receipt.payloadDigest !== p.digest ||
        receipt.type !== command.type ||
        (sendWage ? !receipt.taskId || !receipt.contextId || receipt.requestId !== command.requestId :
          receipt.previousRevision !== command.expectedRevision || receipt.revision !== command.expectedRevision + 1) ||
        (dailyActions.includes(command.type) && (!record || record.id !== target.id || record.revision < receipt.revision)) ||
        typeof receipt.receiptId !== 'string' ||
        !receipt.receiptId ||
        !Number.isFinite(Date.parse(receipt.appliedAt))
      ) {
        if (!reconcile)
          await addEvent(
            db,
            item.id,
            'operation.unknown',
            'Awaiting destination receipt lookup',
            'Mock JURIS',
          )
        return opView(o)
      }
      await db.query('UPDATE cw_juris_intents SET receipt=$2 WHERE operation_id=$1', [o.id, receipt])
      await db.query(
        'INSERT INTO cw_effects(operation_id,receipt_id,payload_digest,applied_payload) VALUES($1,$2,$3,$4)',
        [o.id, receipt.receiptId, p.digest, p.payload],
      )
      if (sendWage) {
        await db.query(`UPDATE cw_wages SET state='awaiting-partner',partner_task_id=$2,partner_context_id=$3
          WHERE send_proposal_id=$1`,[p.id,receipt.taskId,receipt.contextId])
        await db.query("UPDATE cw_items SET state='waiting',reason='Approved wage request accepted',next_action='Await partner response' WHERE id=$1",[item.id])
        await enqueueWage(db,p.payload.requestId,'start')
        await addEvent(db,item.id,'wage.requested','Approved wage request accepted by partner','Amazon wage mock',null)
        return setState('confirmed',receipt.receiptId)
      }
      if (dailyActions.includes(command.type)) {
        const diary = record.diaries.filter(d => d.status==='Open').sort((a,b) => a.dueAt.localeCompare(b.dueAt))[0]
        const message = {add_note:'Claim note added',update_field:'Handling field updated',create_diary:'Diary created',
          reschedule_diary:'Diary rescheduled',complete_diary:'Diary completed'}[command.type]
        const diaryChanged = command.type.endsWith('_diary')
        const instructionChanged = command.type === 'update_field' && command.payload.field === 'nextHandlingInstruction'
        const updated = first(await db.query(`UPDATE cw_items SET version=version+1,source='Mock Juris',
          due_at=CASE WHEN $5 THEN $2::timestamptz ELSE due_at END,
          next_action=CASE WHEN $5 OR $6 THEN $3 ELSE next_action END,reason=$4 WHERE id=$1 RETURNING *`,
          [item.id,diary?.dueAt ?? null,diary?.purpose || record.nextHandlingInstruction || 'Review claim',message,diaryChanged,instructionChanged]))
        const doc = {id:'juris-'+o.id,itemId:item.id,version:1,title:message,kind:'Juris activity',source:'Mock Juris',
          asOf:receipt.appliedAt,anchors:[{id:'entry',label:message,text:Object.values(command.payload).join(' · ')}]}
        await saveDocument(db,doc,doc.source)
        await addEvent(db,item.id,'operation.confirmed',message,'Mock Juris',null,doc.id,'entry')
        // An unrelated approved edit changes the destination revision. Give the employee a
        // fresh review of the same verified packet without disclosing payroll details again.
        const filing = first(await db.query(`SELECT p.* FROM cw_proposals p JOIN cw_wages w ON p.request_id=w.request_id
          WHERE p.item_id=$1 AND p.status='pending' AND p.action='record_wage_evidence'
          AND w.state='awaiting-review' AND w.owner_id=$2 FOR UPDATE OF p`,[item.id,item.owner_id]))
        if (filing && await packetMatches(db,filing)) {
          const source = await selectSource(db,item.id,filing.payload.documentId)
          await db.query("UPDATE cw_proposals SET status='superseded',request_id=NULL WHERE id=$1",[filing.id])
          await expireReviews(db,item.id)
          await stage(db,updated,updated,record,source,filing.payload.anchorId,filing.action,
            {id:filing.creator},filing.request_id,false,filing.payload.artifactDigest)
        } else await expireReviews(db,item.id)
        return setState('confirmed',receipt.receiptId)
      }
      const intake = command.type === 'file_intake_transcript'
      const message = intake ? 'Intake transcript filed in ' + target.id : 'Reviewed wage evidence recorded'
      if (intake) {
        await db.query('UPDATE cw_showcase_records SET filed_claim_id=$2 WHERE item_id=$1', [
          item.id,
          target.id,
        ])
        const doc = await selectSource(db, item.id, p.payload.documentId)
        const attachment = { ...doc, id: 'filed-' + doc.id, itemId: target.id, sourceDocumentId: doc.id }
        await saveDocument(db, attachment, 'Mock JURIS')
        await addEvent(
          db,
          target.id,
          'transcript.filed',
          message,
          'Mock JURIS',
          null,
          attachment.id,
          p.payload.anchorId,
        )
        await db.query('UPDATE cw_items SET version=version+1 WHERE id=$1', [target.id])
        await expireReviews(db, target.id)
      }
      await db.query(
        `UPDATE cw_items SET version=version+1,state=$2,reason=$3,next_action=$4,source='Mock JURIS' WHERE id=$1`,
        [
          item.id,
          intake ? 'filed' : 'ready',
          message,
          intake ? 'Open filed claim' : 'Review wage coverage',
        ],
      )
      await db.query(
        "UPDATE cw_mail SET status='resolved' WHERE item_id=$1 AND evidence_id=$2 AND obligation_event IS NOT NULL",
        [item.id, p.payload.documentId],
      )
      await addEvent(
        db,
        item.id,
        'operation.confirmed',
        message,
        'Mock JURIS',
        null,
        p.payload.documentId,
        p.payload.anchorId,
      )
      await mail(db, item, 'receipt', message, 'Mock JURIS')
      await expireReviews(db, item.id)
      return setState('confirmed', receipt.receiptId)
    })
  }
  return {
    detail,
    prepare,
    checkReview,
    saveIntent,
    dispatch,
    assertAvailable,
    updateReviewState,
    public: {
      document,
      availableActions,
      sourceRecord,
      bindPartnerTask,
      closeUnregisteredWage,
      admitPartnerNotice,
      acceptWage,
      async deliverShowcaseIntake() {
        return transaction(pool, async (db) => {
          const { intakes } = await import('../showcase/data/scenario.mjs')
          const intake = intakes.find((i) => i.id === 'IN-201')
          const row = await insertItem(db, intake, 'intake')
          return { itemId: intake.id, eventId: 'voice-' + intake.id, duplicate: !row }
        })
      },
    },
  }
}
