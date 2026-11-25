import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { migrate, seed, createDomain, scoreBaseline } from '../index.mjs'
import { createClaimReads } from '../../runtime/chat-mcp.mjs'
import { renderDocumentPdf } from '../../showcase/data/pdf.mjs'

const ctx = (principalId) => ({
  principalId,
  tenantId: 'demo',
  profileId: 'claims-v1',
  subject: 'fixture-subject-' + principalId,
})
const maya = ctx('maya'),
  alex = ctx('alex'),
  supervisor = ctx('supervisor')
test('baseline evaluation accounts for unknown labels and tied priorities', () => {
  const rows = [
    { decisionSetId: 'd', label: null, rank: 1, section: 'must' },
    { decisionSetId: 'd', label: 'priority', rank: 2, section: 'must' },
  ]
  const s = scoreBaseline(rows, 1)
  assert.equal(s.mandatoryMisses, 1)
  assert.equal(s.precisionAtK, null)
  assert.equal(s.recallAtK, 0)
  assert.equal(s.labelCoverage, 0.5)
})
test('work service through PostgreSQL', { skip: !process.env.CLAIMS_TEST_DATABASE_URL }, async (t) => {
  const url = process.env.CLAIMS_TEST_DATABASE_URL
  const schema = 'cw_test_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema })
  t.after(async () => {
    await pool.end()
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
    await admin.end()
  })
  await migrate(pool)
  await migrate(pool)
  await seed(pool)
  await seed(pool)
  const api = createDomain(pool)
  await t.test('native Chat reads the baseline portfolio and cites an existing note and timeline', async () => {
    const id = 'WC-101'
    const documentId = 'source-' + id
    // Model a persisted baseline database from before the note projection was installed.
    await pool.query('DROP VIEW cw_chat_note_documents')
    const originalRow = () => pool.query('SELECT * FROM cw_evidence WHERE id=$1', [documentId]).then(res => res.rows[0])
    const previous = await originalRow()
    assert.equal(previous.document, null)
    await migrate(pool)
    assert.deepEqual(await originalRow(), previous)
    const claim = { kind: 'claim', claimIds: [id] }
    const makeReads = (scope, allowed) => createClaimReads({
      principal: maya, domain: api, scope, allowed, signal: new AbortController().signal,
      reauthorize: deps => api.assertChatScope(maya, scope, deps),
    })
    const portfolio = makeReads({ kind: 'portfolio' }, ['search_claims'])
    const search = (await portfolio.call('search_claims', {})).structuredContent
    assert.deepEqual(search.items.map(row => row.id).sort(), [id, 'WC-102'])
    await assert.rejects(api.chatDocuments(alex, id), { status: 404 })
    await assert.rejects(api.chatDocuments(maya, 'TEST-ISOLATION'), { status: 404 })
    const docs = await api.chatDocuments(maya, id)
    assert.deepEqual(docs.items, [{ id: documentId, title: 'Source note', kind: 'Source note', version: 1 }])
    const reads = makeReads(claim, ['get_claim_brief','list_evidence','read_evidence','claim_timeline'])
    const read = async (name, args = {}) => (await reads.call(name, args)).structuredContent
    assert.equal((await read('get_claim_brief')).title, 'Promised callback')
    const [doc] = (await read('list_evidence')).documents
    assert.deepEqual(doc.passages, [{ anchorId: 'body', label: 'Source note' }])
    const source = await read('read_evidence', { documentId, anchorId: 'body' })
    assert.equal(source.quote, (await api.evidence(maya, documentId)).body)
    await read('claim_timeline')
    const { data, refs } = reads.state().timelines.get(id)
    assert.ok(data.events.some(e => e.title === 'Work item assigned'))
    assert.ok(refs.some(ref => ref.documentId === documentId && ref.anchorId === 'body'))
    const pinned = { ...claim, documents: { [id]: [documentId] } }
    await api.assertChatScope(maya, pinned, reads.state().dependencies)
    const chat = await api.openConversation(maya, pinned, { fresh: true })
    const turn = await api.startChatTurn(maya, chat.id, {
      question: 'What does the source note say?', requestId: randomUUID(), expectedRevision: chat.scopeRevision,
    })
    await api.finishChatTurn(maya, chat.id, turn.turnId, turn.attemptId, {
      answer: { text: source.quote, sources: [source] }, activity: [], dependencies: reads.state().dependencies,
    })
    const original = await api.citedChatSource(maya, chat.id, source)
    assert.equal(original.anchors[0].text, source.quote)
    assert.equal(renderDocumentPdf(original).subarray(0, 5).toString(), '%PDF-')
    await assert.rejects(api.citedChatSource(alex, chat.id, source), { status: 404 })
  })
  await t.test('scope before aggregate, stable deadline ranking and evidence access', async () => {
    const p = await api.portfolio(maya)
    assert.equal(p.counts.total, 3)
    assert.equal(p.items[0].id, 'WC-101')
    assert.equal(p.items[0].section, 'must')
    const other = await api.portfolio({ ...maya, profileId: 'legal-test-v1' })
    assert.deepEqual(
      other.items.map((i) => i.id),
      ['TEST-MATTER'],
    )
    await assert.rejects(api.detail(maya, 'TEST-MATTER'), { status: 404 })
    await assert.rejects(api.evidence(maya, 'source-TEST-ISOLATION'), { status: 404 })
    assert.equal((await api.evidence(maya, 'source-WC-101')).itemId, 'WC-101')
    await api.exposure(maya, p.decisionSetId, { itemIds: ['WC-101'] })
    await api.feedback(maya, p.decisionSetId, { itemId: 'WC-101', kind: 'selected', reason: 'Diary due' })
    const learning = await api.dataset(supervisor)
    assert.equal(learning.rows.filter((r) => r.exposed).length, 1)
    assert.equal(learning.rows.find((r) => r.itemId === 'WC-101').label, 'priority')
    assert.equal((await api.evaluate(supervisor, { k: 1 })).recallAtK, 0.5)
    await assert.rejects(api.dataset(maya), { status: 403 })
  })
  await t.test('peer request respects current read rights and requires action ownership', async () => {
    const msg = await api.peerRequest(maya, 'WC-102', {
      recipientId: 'alex',
      expectedVersion: 1,
      message: 'Please review evidence.',
    })
    assert.ok((await api.mailbox(alex)).items.some((m) => m.id === msg.id))
    assert.equal((await api.acknowledge(alex, msg.id)).status, 'read')
    await assert.rejects(api.prepare(alex, 'WC-102', { expectedVersion: 1 }), { status: 403 })
    await assert.rejects(
      api.peerRequest(maya, 'WC-101', { recipientId: 'alex', expectedVersion: 1, message: 'Review' }),
      { status: 404 },
    )
  })
  await t.test('concurrent duplicate fixture deliveries create one timeline entry', async () => {
    const b = { eventId: 'intake-1', fixtureId: 'voice-intake' }
    const results = await Promise.all([api.fixture(maya, b), api.fixture(maya, b)])
    assert.equal(results.filter((r) => r.duplicate).length, 1)
    const d = await api.detail(maya, 'IN-201')
    assert.equal(d.item.version, 2)
    assert.equal(d.timeline.filter((e) => e.kind === 'intake.received').length, 1)
  })
  await t.test(
    'loss of simulated acknowledgement leaves an operation unknown until reconciliation',
    async () => {
      const p = await api.prepare(maya, 'IN-201', { expectedVersion: 2, simulateLostAck: true })
      const traceId = '1'.repeat(32),
        spanId = '2'.repeat(16)
      const r = await api.review({ ...maya, traceId, spanId }, p.id, {
        decision: 'approve',
        expectedVersion: 2,
      })
      assert.deepEqual(await api.operationSpan({ operationId: r.operationId }), { traceId, spanId })
      const input = { operationId: r.operationId }
      assert.equal(
        (await api.review(maya, p.id, { decision: 'approve', expectedVersion: 2 })).operationId,
        r.operationId,
      )
      assert.equal((await api.dispatchable()).items.length, 1)
      assert.equal((await api.dispatchOperation(input)).state, 'unknown')
      assert.equal((await api.dispatchOperation(input)).state, 'unknown')
      const receipts = await Promise.all([api.reconcileOperation(input), api.reconcileOperation(input)])
      assert.ok(receipts[0].receiptId)
      assert.equal(receipts[0].receiptId, receipts[1].receiptId)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM cw_effects')).rows[0].n, 1)
    },
  )
  await t.test('transfer revokes former owner, old snapshot and queued operation', async () => {
    const snapshot = await api.portfolio(maya)
    const p = await api.prepare(maya, 'WC-101', { expectedVersion: 1 })
    const r = await api.review(maya, p.id, { decision: 'approve', expectedVersion: 1 })
    await api.transfer(maya, 'WC-101', { recipientId: 'alex', expectedVersion: 1 })
    await assert.rejects(api.evidence(maya, 'source-WC-101'), { status: 404 })
    await assert.rejects(api.exposure(maya, snapshot.decisionSetId, { itemIds: ['WC-101'] }), { status: 404 })
    assert.equal((await api.detail(alex, 'WC-101')).item.ownerId, 'alex')
    assert.equal((await api.dispatchOperation({ operationId: r.operationId })).state, 'stale')
  })
  await t.test('partner signal requires persisted scoped fixture and reviewer before dispatch', async () => {
    const input = { requestId: 'wage-1', workItemId: 'WC-102' }
    await assert.rejects(api.startWage(input), { status: 404 })
    await assert.rejects(api.admitWage(alex, { ...input, expectedVersion: 1 }), { status: 403 })
    const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
    await api.admitWage({ ...maya, ...parent }, { ...input, expectedVersion: 1 })
    assert.deepEqual(await api.wageSpan(input), parent)
    await api.startWage(input)
    await api.startWage(input)
    await assert.rejects(api.acceptWage({ ...input, eventId: 'fabricated' }), { status: 409 })
    const b = { fixtureId: 'a2a-update', eventId: 'partner-1', requestId: input.requestId }
    await api.fixture(maya, b)
    assert.equal((await api.wageStatus(input)).state, 'awaiting-partner')
    assert.equal((await api.acceptWage({ ...input, eventId: b.eventId })).state, 'awaiting-review')
    assert.equal((await api.acceptWage({ ...input, eventId: b.eventId })).state, 'awaiting-review')
    const p = (await api.detail(maya, 'WC-102')).proposals[0]
    assert.deepEqual(await api.proposalSpan(p.id), parent)
    const r = await api.review(maya, p.id, {
      decision: 'approve',
      expectedVersion: p.version,
      simulateLostAck: true,
    })
    assert.equal((await api.wageStatus(input)).operationId, r.operationId)
    assert.deepEqual((await api.dispatchable()).items, [])
    assert.equal((await api.dispatchOperation({ operationId: r.operationId })).state, 'unknown')
    assert.equal((await api.reconcileOperation({ operationId: r.operationId })).state, 'confirmed')
    assert.equal((await api.wageStatus(input)).state, 'confirmed')
    const commands = (await api.wageDeliveries()).items
    assert.deepEqual(
      commands.map((c) => c.kind),
      ['start', 'evidence', 'review'],
    )
    for (const c of commands) {
      await api.ackWageDelivery(c)
      await api.ackWageDelivery(c)
    }
    assert.deepEqual((await api.wageDeliveries()).items, [])
  })

  await t.test('team intake carries one actionable obligation through acceptance and transfer', async () => {
    const svc = {
      principalId: 'fixture-ingress',
      tenantId: 'demo',
      profileId: 'claims-v1',
      subject: 'service:fixture-ingress:voice-team-intake',
    }
    const b = { fixtureId: 'voice-team-intake', eventId: 'team-call' }
    await api.fixture(svc, b)
    await api.fixture(svc, b)
    await assert.rejects(api.evidence(svc, 'source-WC-101'), { status: 404 })
    const pending = (await api.mailbox(alex)).items.filter((m) => m.obligationEvent === 'team-call')
    assert.equal(pending.length, 1)
    const beforeRestart = await api.detail(alex, 'IN-202')
    await seed(pool)
    assert.deepEqual(await api.detail(alex, 'IN-202'), beforeRestart)
    assert.deepEqual(
      (await api.mailbox(alex)).items.filter((m) => m.itemId === 'IN-202'),
      pending,
    )
    assert.equal((await api.acknowledge(alex, pending[0].id)).status, 'read')
    assert.equal((await api.mailbox(maya)).items.find((m) => m.id === pending[0].id).status, 'unread')
    const team = (await api.detail(alex, 'IN-202')).item
    const accepted = await api.claimIntake(alex, team.id, { expectedVersion: team.version })
    await assert.rejects(api.detail(maya, team.id), { status: 404 })
    await api.transfer(alex, team.id, { recipientId: 'maya', expectedVersion: accepted.version })
    assert.equal(
      (await api.mailbox(maya)).items.filter((m) => m.obligationEvent === 'team-call')[0].id,
      pending[0].id,
    )
    assert.equal((await api.mailbox(alex)).items.filter((m) => m.obligationEvent === 'team-call').length, 0)
  })
  await t.test('scoped question has a single reply and the sender receives the answer', async () => {
    const item = (await api.detail(maya, 'WC-102')).item
    const q = await api.peerRequest(maya, item.id, {
      expectedVersion: item.version,
      recipientId: 'alex',
      kind: 'question',
      message: 'Can you review this source?',
    })
    await api.answer(alex, q.id, { message: 'Reviewed.' })
    await assert.rejects(api.answer(alex, q.id, { message: 'Duplicate' }), { status: 409 })
    assert.ok((await api.mailbox(maya)).items.some((m) => m.kind === 'answer' && m.summary === 'Reviewed.'))
  })
  await t.test(
    'ranking comparison excludes disputed and unlabeled rows and times only observed ranker',
    async () => {
      const p = await api.portfolio(alex, { ranking: 'due-date' })
      assert.equal(p.ranking, 'due-date')
      await api.exposure(alex, p.decisionSetId, { itemIds: ['WC-104'] })
      await api.evidence(alex, 'source-WC-104', { decisionSetId: p.decisionSetId })
      const metrics = await api.evaluate(supervisor, { k: 2 })
      assert.equal(metrics.rankers.length, 2)
      assert.ok(metrics.disputedRows > 0)
      assert.ok(metrics.missingLabelRows > 0)
      const date = metrics.rankers.find((r) => r.ranking === 'due-date')
      assert.ok(date.meanTimeToFirstCorrectMs >= 0 && date.timedSets === 1)
      assert.equal(metrics.rankers.find((r) => r.ranking === 'rules').timedSets, 0)
    },
  )
  await t.test('saved and in-flight sessions require the same subject and current item access', async () => {
    const binding = {
      itemId: 'WC-104',
      expectedVersion: 1,
      mode: 'replay',
      task: 'timeline',
      profileRelease: 'claims-fixture',
    }
    const answer = { text: 'Alex’s synthetic session', sources: [{ id: 'source-WC-104' }] }
    await api.bindSession(alex, { ...binding, sessionId: 'private-completed' })
    await api.finishSession(alex, 'private-completed', answer)
    await api.bindSession(alex, { ...binding, sessionId: 'private-in-flight' })
    assert.equal((await api.session(alex, 'private-completed')).text, answer.text)
    await assert.rejects(api.session({ ...alex, subject: 'replacement-subject' }, 'private-completed'), {
      status: 404,
    })
    await assert.rejects(api.session(supervisor, 'private-completed'), { status: 404 })
    await api.transfer(alex, binding.itemId, { expectedVersion: 1, recipientId: 'maya' })
    await assert.rejects(api.sessions(alex, binding.itemId), { status: 404 })
    await assert.rejects(api.session(alex, 'private-completed'), { status: 404 })
    await assert.rejects(api.finishSession(alex, 'private-in-flight', answer), { status: 404 })
    await assert.rejects(api.session(maya, 'private-completed'), { status: 404 })
    assert.deepEqual((await api.sessions(maya, binding.itemId)).items, [])
    await assert.rejects(api.bindSession(maya, { ...binding, sessionId: 'obsolete' }), {
      code: 'stale_version',
    })
    await api.bindSession(maya, { ...binding, expectedVersion: 2, sessionId: 'new-owner' })
    await api.finishSession(maya, 'new-owner', { text: 'Maya’s separate session', sources: [] })
    assert.deepEqual(
      (await api.sessions(maya, binding.itemId)).items.map((s) => s.sessionId),
      ['new-owner'],
    )
  })
  await t.test('a new source revision closes the old wage review and wakes the workflow', async () => {
    const item = (await api.detail(maya, 'WC-102')).item
    const request = { workItemId: item.id, requestId: 'revision-race' }
    await api.admitWage(maya, { ...request, expectedVersion: item.version })
    await api.fixture(maya, {
      fixtureId: 'a2a-update',
      eventId: 'response-race',
      requestId: request.requestId,
    })
    await api.acceptWage({ ...request, eventId: 'response-race' })
    await api.fixture(maya, { fixtureId: 'ado-update', eventId: 'board-race' })
    const detail = await api.detail(maya, item.id)
    const proposal = detail.proposals.find((p) => p.requestId === request.requestId)
    assert.equal(proposal.status, 'stale')
    assert.equal((await api.wageStatus(request)).state, 'stale')
    assert.ok(
      (await api.wageDeliveries()).items.some(
        (d) => d.requestId === request.requestId && d.kind === 'review',
      ),
    )
    await assert.rejects(
      api.review(maya, proposal.id, { decision: 'approve', expectedVersion: proposal.version }),
      { status: 409 },
    )
    assert.equal(
      (
        await api.admitWage(maya, {
          ...request,
          requestId: 'updated-source',
          expectedVersion: detail.item.version,
        })
      ).state,
      'awaiting-partner',
    )
  })
})
