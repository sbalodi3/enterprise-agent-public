import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { migrate, seed, createDomain } from '../index.mjs'
import { initializeJuris, jurisStore } from '../../showcase/juris/store.mjs'
import { extractDocument } from '../../showcase/cms-mcp/import.mjs'
import { validateSnapshot } from '../../showcase/cms-mcp/snapshot.mjs'
import { renderDocumentPdf } from '../../showcase/data/pdf.mjs'

test('a CMS extract has addressable source values with roles, dates and decimal amounts intact', () => {
  const row = { externalClaimNumber: 'CLM-000099', policyNumber: 'POL-999', lineOfBusiness: 'HOME',
    lineOfBusinessName: 'Homeowners', sourceStatus: 'Paid', sourceAdjusterId: 5, sourceAdjuster: 'Demo Adjuster',
    insured: 'Demo Insured', client: 'Demo Client', office: 'Demo Office', region: 'West',
    incidentDate: '2024-01-01', reportedDate: '2024-01-05', lossDescription: 'Roof damage.',
    billingsAmount: '125.50', deductibleAmount: '0.00', litigated: false }
  const doc = extractDocument(row, '2026-11-20T00:00:00.000Z')
  const anchors = Object.fromEntries(doc.anchors.map(anchor => [anchor.id, anchor.text]))
  assert.match(anchors.identity, /POL-999/)
  assert.match(anchors.assignment, /Insured: Demo Insured. Client: Demo Client/)
  assert.equal(anchors.dates, 'Loss date: 2024-01-01. Reported date: 2024-01-05.')
  assert.equal(anchors.loss, row.lossDescription)
  assert.equal(anchors.financials, 'Billings: 125.50. Deductible: 0.00. Litigated: No.')
  assert.match(renderDocumentPdf(doc).toString(), /\(financials\) \[/)
  assert.throws(() => validateSnapshot({ rows: [row] }), /Invalid CMS-MCP snapshot/)
})

const url = process.env.CLAIMS_CMS_TEST_DATABASE_URL
const snapshotUrl = process.env.CLAIMS_CMS_TEST_SNAPSHOT ||
  new URL('../../../.artifacts/claims-showcase/cms-mcp/snapshot.json', import.meta.url)

test('pinned all-lines seed is atomic, idempotent, additive and reversible in a populated showcase', { skip: !url }, async t => {
  const cmsSnapshot = validateSnapshot(JSON.parse(await readFile(snapshotUrl, 'utf8')))
  const admin = new pg.Pool({ connectionString: url })
  const name = 'cms_test_' + randomUUID().replaceAll('-', '')
  await admin.query('CREATE DATABASE ' + name)
  const local = new URL(url)
  local.pathname = '/' + name
  const pool = new pg.Pool({ connectionString: local.toString() })
  t.after(async () => {
    await pool.end()
    try { await admin.query('DROP DATABASE ' + name) } finally { await admin.end() }
  })
  await migrate(pool)
  await seed(pool, { showcase: true })
  const story = (await pool.query('SELECT id,owner_id,version FROM cw_items ORDER BY id')).rows
  // A pre-existing unrelated record with the same canonical ID must abort the entire batch.
  await pool.query(`INSERT INTO cw_items(id,tenant,profile,owner_id,type,title,state,reason,next_action,as_of,source)
    SELECT 'CLM-000200',tenant,profile,owner_id,type,title,state,reason,next_action,as_of,source FROM cw_items WHERE id='WC-101'`)
  await pool.query("INSERT INTO cw_showcase_records(item_id,facts) VALUES ('CLM-000200','{}')")
  await assert.rejects(seed(pool, { showcase: true, cmsSnapshot }), { code: '23505' })
  assert.equal((await pool.query('SELECT id FROM cw_items WHERE external_claim_number IS NOT NULL')).rowCount, 0)
  await pool.query("DELETE FROM cw_showcase_records WHERE item_id='CLM-000200'")
  await pool.query("DELETE FROM cw_items WHERE id='CLM-000200'")
  await Promise.all([seed(pool, { showcase: true, cmsSnapshot }), seed(pool, { showcase: true, cmsSnapshot })])
  const { rows } = await pool.query(`SELECT line_of_business, count(*)::int AS count FROM cw_items
    WHERE external_claim_number IS NOT NULL GROUP BY line_of_business`)
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.line_of_business, row.count])),
    { PC: 33, AUTO: 33, COMM_AUTO: 33, HOME: 33, WC: 34, HEALTH: 34 })
  const stats = (await pool.query(`SELECT COUNT(*)::int AS count,SUM((facts->>'billingsAmount')::numeric)::text AS billings,
    COUNT(*) FILTER (WHERE (facts->>'litigated')::boolean)::int AS litigated
    FROM cw_showcase_records WHERE facts->>'sourceDataset'='cms-mcp'`)).rows[0]
  assert.deepEqual(stats, { count: 200, billings: '3173820.00', litigated: 29 })
  assert.equal((await pool.query("SELECT id FROM cw_evidence WHERE id LIKE 'CLM-%-extract'")).rowCount, 200)
  assert.equal((await pool.query("SELECT id FROM cw_events WHERE item_id LIKE 'CLM-%'")).rowCount, 600)
  const owners = (await pool.query("SELECT owner_id,count(*)::int AS count FROM cw_items WHERE external_claim_number IS NOT NULL GROUP BY owner_id")).rows
  assert.equal(owners.length, 20)
  assert.ok(owners.every(row => row.count === 10))
  assert.deepEqual((await pool.query('SELECT id,owner_id,version FROM cw_items WHERE external_claim_number IS NULL ORDER BY id')).rows, story)
  await pool.query("UPDATE cw_items SET owner_id='maya',version=version+1 WHERE id='CLM-000001'")
  await initializeJuris(pool,cmsSnapshot)
  const domain = createDomain(pool, { showcase: {juris:jurisStore(pool)} })
  const adminScope = { tenantId: 'demo', principalId: 'claims-admin' }
  for (const [sourceStatus, count, billings] of [
    ['Denied', 20, '0.00'], ['Paid', 60, '1878000.00'], ['Under Investigation', 20, '0.00'], ['Closed', 40, '1295820.00'],
  ]) {
    const group = await domain.portfolioSummary(adminScope, { sourceStatus })
    assert.equal(group.total, count)
    assert.equal(group.totalBillings, billings)
    assert.ok(group.groups.every(g => g.items.every(i => i.sourceStatus === sourceStatus)))
  }
  assert.equal((await domain.portfolioSummary(adminScope, { status: 'closed' })).total, 120)
  const filters = { status: 'open', lobs: ['AUTO', 'COMM_AUTO'] }
  const first = await domain.chatSearch(adminScope, filters)
  const next = await domain.chatSearch(adminScope, { ...filters, offset: 12 })
  const last = await domain.chatSearch(adminScope, { ...filters, offset: 24 })
  assert.equal(first.total, 26)
  assert.equal((await domain.portfolioSummary(adminScope, filters)).total, first.total)
  const matches = [...first.items, ...next.items, ...last.items]
  assert.equal(new Set(matches.map(row => row.id)).size, first.total)
  assert.ok(matches.every(row => filters.lobs.includes(row.lob) && row.lifecycle === 'open'))
  assert.equal((await domain.chatSearch(adminScope, { ...filters, sourceStatus: 'Under Investigation' })).total, 6)
  const owner = { tenantId: 'demo', principalId: matches[0].ownerId }
  const personal = await domain.chatSearch(owner, { ...filters, assignedOnly: true })
  assert.equal(personal.total, matches.filter(row => row.ownerId === owner.principalId).length)
  assert.ok(personal.items.every(row => row.ownerId === owner.principalId))
  for (const wrong of [{ lobs: [] }, { lobs: ['UNKNOWN'] }, { lobs: ['AUTO','AUTO'] }, { lob: 'AUTO', lobs: ['HOME'] }])
    assert.throws(() => domain.chatSearch(adminScope, wrong), { code: 'invalid_claim_search' })
  const scoped = await domain.portfolioSummary(adminScope, { ownerId: 'cms-adjuster-02', sourceStatus: 'Denied' })
  assert.equal(scoped.total, 10)
  assert.throws(() => domain.portfolioSummary(adminScope, { sourceStatus: 'Complete' }), { code: 'invalid_summary' })
  const maya = { tenantId: 'demo', principalId: 'maya' }
  await seed(pool, { showcase: true })
  assert.equal((await pool.query("SELECT active FROM cw_datasets WHERE id='cms-mcp'")).rows[0].active, false)
  await assert.rejects(domain.detail(maya, 'CLM-000001'), { status: 404 })
  await assert.rejects(domain.transfer(maya, 'WC-101', { expectedVersion: 1, recipientId: 'cms-adjuster-01' }), { status: 404 })
  await seed(pool, { showcase: true, cmsSnapshot })
  const one = await domain.detail(maya, 'CLM-000001')
  assert.equal(one.item.ownerId, 'maya')
  assert.equal(one.item.version, 2)
  assert.equal(one.showcase.sourceAdjusterId, 14)
  assert.equal(one.showcase.documents[0].version, 1)
  assert.equal(one.timeline.length, 3)
  assert.deepEqual(one.showcase.capabilities, { juris: true, intakeTarget: false, wageRequest: false })
  assert.equal((await domain.sourceRecord(maya,'CLM-000001')).revision,1)
  await assert.rejects(domain.admitWage(maya, { requestId: 'cms-wage', workItemId: 'CLM-000001', expectedVersion: 2 }),
    { code: 'wage_ineligible' })
})
