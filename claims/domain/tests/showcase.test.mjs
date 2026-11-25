import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { migrate, seed, createDomain } from '../index.mjs'
import { createJurisClient } from '../juris-client.mjs'
import { createJurisServer } from '../../showcase/juris/server.mjs'
import { initializeJuris, jurisStore } from '../../showcase/juris/store.mjs'

const url = process.env.CLAIMS_SHOWCASE_TEST_DATABASE_URL
const ctx = (principalId) => ({
  principalId,
  tenantId: 'demo',
  profileId: 'claims-v1',
  subject: 'sub-' + principalId,
})
const maya = ctx('maya'),
  alex = ctx('alex')
const fixture = {
  schema: 'query.wage_evidence/1.0.0/output',
  data: {
    payPeriods: [
      {
        periodStart: '2026-06-01',
        periodEnd: '2026-06-14',
        grossEarnings: { amount: '1830.00', currency: 'USD' },
        hours: { regular: 80, overtime: 4 },
      },
    ],
  },
  provenance: {
    sourceSystem: 'mock-adp',
    asOf: '2026-11-17T13:00:00Z',
    recordIds: ['pay-1'],
    policyDecisionId: 'private-decision-r31',
    sensitivityTier: 'internal',
    withheld: [],
    payloadHash: 'sha256:' + 'a'.repeat(64),
  },
}

// A new database keeps the separate mock JURIS schema and receipts independent of other test runs.
test(
  'connected Workbench reviews and verifies one destination change over HTTP',
  { skip: !url },
  async (t) => {
    const admin = new pg.Pool({ connectionString: url })
    const database = 'showcase_test_' + randomUUID().replaceAll('-', '')
    await admin.query('CREATE DATABASE ' + database)
    const isolated = new URL(url)
    isolated.pathname = '/' + database
    const pool = new pg.Pool({ connectionString: isolated.toString() })
    let server
    t.after(async () => {
      if (server) await new Promise((resolve) => server.close(resolve))
      await pool.end()
      await admin.query('DROP DATABASE ' + database)
      await admin.end()
    })
    await migrate(pool)
    await seed(pool, { showcase: true })
    await seed(pool, { showcase: true })
    await assert.rejects(seed(pool), /isolated_database/)
    await initializeJuris(pool)
    server = createJurisServer(jurisStore(pool), 'showcase-test')
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const juris = createJurisClient({
      url: 'http://127.0.0.1:' + server.address().port,
      token: 'showcase-test',
    })
    const partner=async command=>{
      const taskId=({'wage-1':'task-1','wage-stale':'late','wage-alex':'fresh'})[command.requestId]
      return {...command,taskId,receiptId:taskId,contextId:command.requestId==='wage-1'?'context-1':'context-'+taskId,appliedAt:new Date().toISOString()}
    }
    const api = createDomain(pool, { showcase: { juris,partner } })
    async function approveSend(actor,request) {
      const draft=await api.admitWage(actor,request)
      const op=await api.review(actor,draft.id,{decision:'approve',expectedVersion:draft.version})
      assert.equal((await api.dispatchOperation(op)).state,'confirmed')
    }
    const total = await api.portfolio(ctx('supervisor'))
    assert.equal(total.items.filter((i) => i.type === 'claim').length, 12)
    const initial = await api.portfolio(maya)
    assert.deepEqual(
      initial.items.slice(0, 2).map((row) => row.id),
      ['WC-101', 'WC-111'],
    )
    const byDue = await api.portfolio(maya, { ranking: 'due-date' })
    assert.deepEqual(
      byDue.items.slice(0, 2).map((row) => row.id),
      ['WC-101', 'WC-111'],
    )
    const section = async (id) => (await api.portfolio(maya)).items.find((i) => i.id === id)?.section
    assert.equal(await section('WC-102'), 'must')
    assert.equal(total.items.filter((i) => i.ownerId === 'maya').length, 6)
    assert.equal((await api.detail(maya, 'IN-202')).showcase.candidates.length, 0)
    await assert.rejects(api.detail(maya, 'IN-201'), { status: 404 })
    const [first, second] = await Promise.all([api.deliverShowcaseIntake(), api.deliverShowcaseIntake()])
    assert.notEqual(first.duplicate, second.duplicate)
    assert.equal((await api.mailbox(maya)).items.filter((m) => m.itemId === 'IN-201').length, 1)
    const i = await api.detail(maya, 'IN-201')
    assert.deepEqual(
      i.showcase.candidates.map((c) => c.id),
      ['WC-105', 'WC-107'],
    )
    const source = {
      action: 'file_intake_transcript',
      expectedVersion: 1,
      evidenceId: 'IN-201-call',
      anchorId: 'worksite',
      targetClaimId: 'WC-105',
    }
    await assert.rejects(api.prepare(maya, 'IN-201', { ...source, targetClaimId: 'WC-104' }), { status: 404 })
    await assert.rejects(api.prepare(maya, 'IN-201', { ...source, targetClaimId: 'WC-101' }), {
      code: 'invalid_match',
    })
    await assert.rejects(api.prepare(maya, 'IN-201', { ...source, evidenceId: 'WC-105-report' }), {
      code: 'invalid_citation',
    })
    const staleProposal = await api.prepare(maya, 'IN-201', { ...source, targetClaimId: 'WC-107' })
    await api.transfer(maya, 'WC-107', { recipientId: 'alex', expectedVersion: 1 })
    await assert.rejects(api.review(maya, staleProposal.id, { decision: 'approve', expectedVersion: 1 }), {
      status: 404,
    })
    await assert.rejects(api.document(maya, 'WC-107', 'WC-107-report'), { status: 404 })
    const proposal = await api.prepare(maya, 'IN-201', source)
    assert.equal(
      proposal.payload.quote,
      i.showcase.documents[0].anchors.find((a) => a.id === 'worksite').text,
    )
    const review = await api.review(maya, proposal.id, {
      decision: 'approve',
      expectedVersion: 1,
      simulateLostAck: true,
    })
    assert.equal((await api.sourceRecord(maya, 'WC-105')).revision, 1)
    assert.equal((await api.dispatchOperation(review)).state, 'unknown')
    assert.equal((await api.sourceRecord(maya, 'WC-105')).revision, 2)
    await assert.rejects(api.transfer(maya, 'WC-105', { expectedVersion: 1, recipientId: 'alex' }), {
      code: 'awaiting_destination_receipt',
    })
    const [r1, r2] = await Promise.all([api.reconcileOperation(review), api.reconcileOperation(review)])
    assert.equal(r1.receiptId, r2.receiptId)
    assert.equal(r1.state, 'confirmed')
    assert.equal((await api.sourceRecord(maya, 'WC-105')).receipts.length, 1)
    assert.equal((await api.detail(maya, 'IN-201')).showcase.filedClaimId, 'WC-105')
    assert.equal(await section('IN-201'), undefined)
    assert.equal(
      (await api.document(maya, 'WC-105', 'filed-IN-201-call')).anchors.length,
      i.showcase.documents[0].anchors.length,
    )
    assert.equal(
      (await api.mailbox(maya)).items.find((m) => m.evidenceId === 'IN-201-call').status,
      'resolved',
    )
    await assert.rejects(api.prepare(maya, 'IN-201', { ...source, expectedVersion: 2 }), {
      code: 'intake_already_filed',
    })

    const wage = { requestId: 'wage-1', workItemId: 'WC-102', expectedVersion: 1 }
    const binding = {
      ...wage,
      signedResponseHash: 'sha256:' + 'b'.repeat(64),
      taskId: 'task-1',
      contextId: 'context-1',
      eventId: 'wage-result:task-1',
    }
    await approveSend(maya,wage)
    assert.equal(await section('WC-102'), 'waiting')
    await api.bindPartnerTask(binding)
    await assert.rejects(api.admitPartnerNotice({ ...binding, taskId: 'other' }), { status: 409 })
    await api.admitPartnerNotice(binding)
    assert.equal((await api.admitPartnerNotice(binding)).duplicate, true)
    await assert.rejects(api.acceptWage({ ...binding, artifact: {} }), { code: 'unverified_partner_event' })
    await assert.rejects(api.acceptWage({ ...binding, workItemId: 'WC-101', artifact: fixture }), {
      code: 'wrong_partner_task',
    })
    await assert.rejects(api.acceptWage({ ...binding, contextId: 'mismatched', artifact: fixture }), {
      code: 'wrong_partner_task',
    })
    await api.acceptWage({ ...binding, artifact: fixture })
    await api.acceptWage({ ...binding, artifact: fixture })
    await pool.query(
      "INSERT INTO cw_evidence(id,item_id,source,title,body,as_of) VALUES('unrelated','WC-102','Diary','Later diary entry','Different evidence','2027-01-01')",
    )
    const w = await api.detail(maya, 'WC-102')
    assert.equal(await section('WC-102'), 'ready')
    assert.equal(w.proposals.length,2)
    w.proposals=w.proposals.filter(p=>p.action==='record_wage_evidence')
    assert.equal(w.proposals[0].payload.evidenceId, 'wage-wage-1')
    assert.equal(w.proposals[0].payload.version, 2)
    assert.equal(w.proposals[0].payload.expectedRevision, 1)
    assert.match(w.proposals[0].payload.quote, /1830.00/)
    const stored = (
      await pool.query("SELECT document->'verification' AS packet FROM cw_evidence WHERE id='wage-wage-1'")
    ).rows[0].packet
    assert.deepEqual(stored.artifact, fixture)
    assert.equal(stored.signedResponseHash, binding.signedResponseHash)
    assert.equal(stored.contextId, binding.contextId)
    assert.doesNotMatch(JSON.stringify(w), /private-decision-r31/)
    assert.doesNotMatch(
      JSON.stringify(await api.document(maya, 'WC-102', 'wage-wage-1')),
      /private-decision-r31/,
    )
    assert.match(w.proposals[0].payload.artifactDigest, /^[0-9a-f]{64}$/)
    await pool.query(
      "UPDATE cw_evidence SET document=jsonb_set(document,'{verification,signedResponseHash}',to_jsonb($2::text)) WHERE id=$1",
      ['wage-wage-1', 'sha256:' + '9'.repeat(64)],
    )
    await assert.rejects(api.review(maya, w.proposals[0].id, { decision: 'approve', expectedVersion: 2 }), {
      code: 'stale_evidence_packet',
    })
    await pool.query(
      "UPDATE cw_evidence SET document=jsonb_set(document,'{verification}',$2::jsonb) WHERE id=$1",
      ['wage-wage-1', stored],
    )
    const approval = await api.review(maya, w.proposals[0].id, { decision: 'approve', expectedVersion: 2 })
    await api.dispatchOperation(approval)
    assert.equal((await api.dispatchOperation(approval)).state, 'confirmed')
    assert.equal(await section('WC-102'), 'must')
    const actual = await api.sourceRecord(maya, 'WC-102')
    assert.equal(actual.receipts.length, 1)
    assert.equal(actual.wageEvidence.documentId, w.proposals[0].payload.documentId)
    assert.equal(actual.wageEvidence.artifactDigest, w.proposals[0].payload.artifactDigest)
    assert.equal(actual.receipts[0].payloadDigest, w.proposals[0].digest)
    const newRequest = { ...wage, requestId: 'wage-stale', expectedVersion: 3 }
    await approveSend(maya,newRequest)
    await api.bindPartnerTask({ ...newRequest, taskId: 'late' })
    await api.transfer(maya, 'WC-102', { recipientId: 'alex', expectedVersion: 3 })
    await assert.rejects(
      api.admitPartnerNotice({ ...newRequest, taskId: 'late', contextId:'context-late', eventId: 'wage-result:late' }),
      { status: 409 },
    )
    await assert.rejects(api.document(maya, 'WC-102', 'wage-wage-1'), { status: 404 })
    const fresh = {
      ...wage,
      requestId: 'wage-alex',
      signedResponseHash: 'sha256:' + 'c'.repeat(64),
      expectedVersion: 4,
      taskId: 'fresh',
      eventId: 'wage-result:fresh',
    }
    fresh.contextId='context-fresh'
    await approveSend(alex,fresh)
    await api.bindPartnerTask(fresh)
    await api.admitPartnerNotice(fresh)
    await api.acceptWage({ ...fresh, artifact: fixture })
    const replacement = (await api.detail(alex, 'WC-102')).proposals.find(
      (p) => p.requestId === fresh.requestId,
    )
    const queued = await api.review(alex, replacement.id, { decision: 'approve', expectedVersion: 5 })
    await pool.query("UPDATE mock_juris.claims SET revision=revision+1 WHERE id='WC-102'")
    assert.equal((await api.dispatchOperation(queued)).state, 'stale')
    assert.equal((await api.sourceRecord(alex, 'WC-102')).receipts.length, 1)
  },
)
