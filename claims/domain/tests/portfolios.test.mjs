import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { migrate, seed } from '../index.mjs'
import { createPortfolioStore } from '../../portfolios/store.mjs'
import { records } from '../../portfolios/fixtures.mjs'

const user = (id) => ({ tenantId: 'demo', principalId: id, subject: 'subject-' + id })
const legal = user('legal'),
  finance = user('finance'),
  alex = user('alex')
const approval = (action, rec) => ({ action, expectedVersion: rec.version, requestId: randomUUID() })

test('synthetic portfolios have six distinct records each with source-linked totals and standalone records', () => {
  for (const department of ['legal', 'finance']) {
    const own = records.filter((r) => r.department === department)
    assert.equal(own.length, 6)
    assert.ok(own.some((r) => r.linkedClaimId === null))
    for (const rec of own) {
      for (const point of [...(rec.chronology || []), ...(rec.invoiceRows || []), ...(rec.stagedRows || [])]) {
        const doc = rec.sources.find((s) => s.id === point.sourceId)
        assert.ok(doc?.passages.some((p) => p.id === point.anchorId))
      }
    }
  }
})

test(
  'department ownership, approved receipts and redacted A2A mail in PostgreSQL',
  { skip: !process.env.CLAIMS_TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.CLAIMS_TEST_DATABASE_URL
    const schema = 'ep_port_test_' + randomUUID().replaceAll('-', '')
    const admin = new pg.Pool({ connectionString })
    await admin.query('CREATE SCHEMA ' + schema)
    const pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema })
    t.after(async () => {
      await pool.end()
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
      await admin.end()
    })
    await migrate(pool)
    await seed(pool, { showcase: true })
    const service = createPortfolioStore(pool)
    await Promise.all([service.seed(), service.seed()])
    const matter = 'MAT-017',
      bill = 'FIN-207'
    await t.test('employee scope limits lists, source deep links and summaries', async () => {
      assert.equal((await service.list(legal)).items.length, 6)
      assert.equal((await service.list(finance)).items.length, 6)
      assert.equal(await service.bootstrap(alex), null)
      await assert.rejects(service.detail(finance, matter), { status: 404 })
      await assert.rejects(service.source(finance, bill, 'PREP-017'), { status: 404 })
      await assert.rejects(service.act(legal, bill, { action: 'open_review' }), { status: 404 })
      await assert.rejects(service.list({ ...finance, tenantId: 'another' }), { status: 403 })
      assert.equal((await service.source(legal, matter, 'PREP-017')).kind, 'Legal team only')
      const legalDeadline = await service.ask(legal, null, 'Which requests due this week are missing a source?')
      assert.match(legalDeadline.text, /MAT-017/)
      assert.doesNotMatch(legalDeadline.text, /MAT-023|MAT-034|FIN-/)
      const dates = await service.ask(legal, matter, 'Prepare the incident chronology')
      assert.match(dates.text, /November 9.+November 10.+November 17/)
      assert.deepEqual(
        dates.sources.map((s) => s.anchorId),
        ['account', 'date', 'recorded'],
      )
      assert.deepEqual((await service.ask(legal, matter, 'Predict tomorrow’s weather')).sources, [])
      const financeDetail = await service.detail(finance, bill)
      const { invoiceCents, stagedCents, varianceCents } = financeDetail.reconciliation
      assert.deepEqual([invoiceCents, stagedCents, varianceCents], [900000, 960000, 60000])
      const result = await service.ask(finance, bill, 'Explain the variance')
      assert.equal(result.sources.length, 5)
      assert.match(result.text, /\$600\.00 expense lines with reference EXP-044/)
    })

    await t.test('packet pins the approved evidence and alerts the assigned adjuster only', async () => {
      const rec = await service.detail(legal, matter)
      const packet = approval('approve_packet', rec)
      await assert.rejects(service.act(legal, matter, { ...packet, recipient: 'somewhere else' }), {
        code: 'invalid_portfolio_action',
      })
      const [a, b] = await Promise.all([service.act(legal, matter, packet), service.act(legal, matter, packet)])
      assert.equal(a.version, b.version)
      assert.equal(a.receipts.length, 1)
      assert.deepEqual(
        a.receipts[0].payload.sources.map((s) => s.id),
        ['WC-103-report', 'WC-103-shift'],
      )
      assert.equal(a.receipts[0].digest.length, 64)
      const packetRecord = a.receipts[0].destination
      assert.match(packetRecord.id, /^PACKET-/)
      assert.deepEqual(packetRecord.fields, rec.actions.find((a) => a.id === 'approve_packet').filing.fields)
      assert.match(JSON.stringify(packetRecord.fields), /November 9/)
      assert.match(JSON.stringify(packetRecord.fields), /November 10/)
      assert.doesNotMatch(JSON.stringify(packetRecord), /PREP-017|AUTH-600-01|interview/)

      await assert.rejects(service.act(legal, matter, { ...packet, action: 'request_confirmation' }), {
        code: 'request_id_conflict',
      })
      await assert.rejects(service.act(legal, matter, approval('request_confirmation', rec)), {
        code: 'stale_version',
      })
      const { rows } = await pool.query(
        "SELECT recipient,summary FROM cw_mail WHERE item_id='WC-103' AND kind='Legal packet filed'",
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].recipient, 'alex')
      assert.doesNotMatch(rows[0].summary, /PREP-017|interview|AUTH-600-01/)
    })

    await t.test(
      'Finance and Legal each approve their own payload, retry deliveries, then open a new task',
      async () => {
        const question = 'Was a second $600 expense authorized?'
        const unsent = await service.ask(finance, bill, question)
        assert.match(unsent.text, /No authorization request/)
        assert.deepEqual(unsent.sources, [])
        const billRecord = await service.detail(finance, bill)
        let fin = await service.act(finance, bill, approval('open_review', billRecord))
        assert.equal(fin.receipts[0].id.startsWith('REV-'), true)
        const input = approval('ask_legal', fin)
        fin = await service.act(finance, bill, input)
        const handoff = fin.referral.id
        assert.equal(fin.referral.state, 'queued')
        assert.equal((await service.detail(legal, matter)).referral, null)
        assert.deepEqual(await service.pendingHandoffs(), [
          {
            id: handoff,
            financeId: bill,
            matterId: matter,
            state: 'queued',
            invoiceRef: 'INV-318',
            expenseRef: 'EXP-044',
            amountCents: 60000,
          },
        ])
        await Promise.all([service.noteHandoffSent(handoff), service.noteHandoffSent(handoff)])
        let mat = await service.detail(legal, matter)
        assert.equal(mat.referral.state, 'awaiting_legal')
        assert.equal((await service.list(legal)).mail.filter((m) => m.id === handoff + '-send').length, 1)
        const reply = approval('reply_finance', mat)
        mat = await service.act(legal, matter, reply)
        assert.equal(mat.referral.state, 'reply_queued')
        fin = await service.detail(finance, bill)
        assert.equal(fin.referral.state, 'awaiting_legal')
        assert.equal(fin.referral.disposition, undefined)
        const pending = await service.ask(finance, bill, question)
        assert.match(pending.text, /not been verified/)
        assert.deepEqual(pending.sources, [])
        await assert.rejects(service.source(finance, bill, 'A2A-' + handoff), { status: 404 })
        await assert.rejects(
          service.finishHandoff(handoff, { disposition: 'amendment_found', reference: 'other' }),
          { code: 'handoff_result_mismatch' },
        )
        const [queued] = await service.pendingHandoffs()
        await Promise.all([service.finishHandoff(handoff, queued), service.finishHandoff(handoff, queued)])
        fin = await service.detail(finance, bill)
        assert.equal(fin.referral.reference, 'AUTH-600-01')
        assert.equal(fin.referral.state, 'completed')
        const approved = await service.ask(finance, bill, 'Did Legal approve the second invoice expense?')
        assert.match(approved.text, /No second authorization/)
        assert.deepEqual(
          approved.sources.map((s) => [s.recordId, s.sourceId, s.anchorId]),
          [[bill, 'A2A-' + handoff, 'disposition']],
        )
        const receiptSource = await service.source(finance, bill, approved.sources[0].sourceId)
        assert.equal(receiptSource.passages[0].text, approved.text)
        assert.doesNotMatch(JSON.stringify(receiptSource), /PREP-017|interview|November/)
        await assert.rejects(service.source(finance, bill, 'AUTH-600-01'), { status: 404 })
        await assert.rejects(service.source(legal, matter, receiptSource.id), { status: 404 })
        assert.equal((await service.list(finance)).mail.filter((m) => m.id === handoff + '-reply').length, 1)
        assert.doesNotMatch(JSON.stringify(fin), /PREP-017|interview sequencing|November 10/)
        await seed(pool, { showcase: true })
        await service.seed()
        const restarted = await service.detail(finance, bill)
        assert.equal(restarted.referral.id, handoff)
        const registered = restarted.receipts.find((r) => r.action === 'open_review').destination
        assert.match(registered.id, /^BILLREV-/)
        assert.equal(registered.fields.find((f) => f.label === 'Variance').value, '$600.00')
        assert.equal(
          (await service.detail(legal, matter)).receipts.filter((r) => r.action === 'approve_packet').length,
          1,
        )
        assert.equal((await pool.query('SELECT 1 FROM ep_port_filed_records')).rowCount, 2)
        const retry = await service.act(finance, bill, input)
        assert.equal(retry.referrals.length, 1)
        fin = await service.act(finance, bill, approval('ask_legal', retry))
        assert.equal(fin.referrals.length, 2)
        assert.notEqual(fin.referral.id, handoff)
        await pool.query(
          "UPDATE ep_port_records SET contents=jsonb_set(contents,'{sources,0,version}','2') WHERE item_id=$1",
          [bill],
        )
        assert.deepEqual(await service.pendingHandoffs(), [])
        await assert.rejects(service.noteHandoffSent(fin.referral.id), { code: 'handoff_approval_unavailable' })
        await pool.query(
          "UPDATE ep_port_records SET contents=jsonb_set(contents,'{sources,0,version}','1') WHERE item_id=$1",
          [bill],
        )
        assert.equal((await service.pendingHandoffs()).length, 1)
        await pool.query(
          "INSERT INTO cw_principals(tenant,profile,id,role) VALUES('demo','finance-v1','replacement','finance')",
        )
        await pool.query("UPDATE cw_items SET owner_id='replacement' WHERE id=$1", [bill])
        await assert.rejects(service.detail(finance, bill), { status: 404 })
        assert.deepEqual(await service.pendingHandoffs(), [])
        await assert.rejects(service.noteHandoffSent(fin.referral.id), { code: 'handoff_approval_unavailable' })
      },
    )
  },
)
