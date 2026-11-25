import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { migrate, seed, createDomain } from '../index.mjs'
import { createClaimReads, startClaimMcp } from '../../runtime/chat-mcp.mjs'
import { initializeJuris, jurisStore } from '../../showcase/juris/store.mjs'

const url = process.env.CLAIMS_CMS_TEST_DATABASE_URL
const snapshotPath = process.env.CLAIMS_CMS_TEST_SNAPSHOT || new URL('../../../.artifacts/claims-showcase/cms-mcp/snapshot.json', import.meta.url)

test('CMS portfolios reconcile across all twenty owners and remain scoped through transfers, approvals and opt-out',
  { skip: !url }, async t => {
    const cmsSnapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
    const dbName = 'cms_supervision_' + randomUUID().replaceAll('-', '')
    const adminDb = new pg.Pool({ connectionString: url })
    await adminDb.query('CREATE DATABASE ' + dbName)
    const address = new URL(url)
    address.pathname = '/' + dbName
    const pool = new pg.Pool({ connectionString: address.href })
    t.after(async () => {
      await pool.end()
      try { await adminDb.query('DROP DATABASE ' + dbName) } finally { await adminDb.end() }
    })
    await migrate(pool)
    await seed(pool, { showcase: true, cmsSnapshot })
    await initializeJuris(pool)
    const domain = createDomain(pool, { showcase: { juris: jurisStore(pool) } })
    const employee = principalId => ({ principalId, tenantId: 'demo', profileId: 'claims-v1' })
    const admin = employee('claims-admin')
    const aisha = employee('cms-adjuster-01'), brandon = employee('cms-adjuster-02')
    const summary = await domain.portfolioSummary(admin)
    assert.equal(summary.total, 200)
    assert.equal(summary.totalBillings,'3173820.00')
    assert.equal(summary.litigatedCount,29)
    assert.deepEqual(summary.groups.map(g => [g.key,g.count]), [
      ['AUTO',33],['COMM_AUTO',33],['HEALTH',34],['HOME',33],['PC',33],['WC',34],
    ])
    assert.equal(summary.groups.reduce((sum,g) => sum + Number(g.billingsAmount),0),3173820)
    assert.equal(summary.groups.reduce((sum,g) => sum + g.litigatedCount,0),29)
    assert.equal((await domain.portfolioSummary(admin, {status:'open'})).total,80)
    const controller = new AbortController()
    const scope = { kind: 'portfolio' }
    const reads = createClaimReads({ domain, principal:admin, scope, allowed:['search_claims','portfolio_summary'],
      reauthorize: deps => domain.assertChatScope(admin,scope,deps), signal:controller.signal })
    const mcp = await startClaimMcp(reads,controller.signal)
    try {
      const rpc = async (method,params) => {
        const res = await fetch(mcp.url,{ method:'POST', headers:{authorization:mcp.authorization, 'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}) })
        return (await res.json()).result
      }
      const tool = (await rpc('tools/list')).tools.find(t => t.name === 'portfolio_summary')
      const uri = tool._meta.ui.resourceUri
      assert.ok((await rpc('resources/list')).resources.some(r => r.uri === uri))
      assert.match((await rpc('resources/read',{uri})).contents[0].text,/Portfolio summary/)
      const response = await rpc('tools/call',{name:tool.name,arguments:{groupBy:'adjuster'}})
      assert.equal(response.structuredContent.groups.length,20)
      assert.equal(response.structuredContent.total,200)
      assert.equal(reads.state().dependencies.length,200)
      assert.ok(!response.content[0].text.includes('CLM-000001'))
    } finally { await mcp.close() }
    const assignees = (await domain.adjusters(admin)).items.filter(p => p.id.startsWith('cms-adjuster-'))
    assert.equal(assignees.length,20)
    for (const { id } of assignees) {
      const owner = employee(id)
      const portfolio = await domain.portfolio(owner, { status: 'all' })
      assert.equal(portfolio.items.length,10)
      assert.ok(portfolio.items.every(item => item.ownerId === id))
      assert.equal((await domain.chatSearch(owner, { status:'all' })).total,10)
    }
    const id = 'CLM-000017'
    assert.equal((await domain.chatSearch(brandon, { query: id.toLowerCase() })).total,1)
    assert.equal((await domain.portfolio(brandon, { query: id.toLowerCase() })).items[0].sourceStatus,'Denied')
    const denied = await domain.portfolio(brandon, { query:'denied', status:'all' })
    assert.deepEqual(denied.counts,{ must:0, ready:0, waiting:0, total:10 })
    assert.ok(denied.items.every(item => item.sourceStatus === 'Denied'))
    const auto = await domain.portfolio(brandon, { query:'auto', status:'closed' })
    assert.ok(auto.items.some(item => item.id === id))
    assert.equal((await domain.chatSearch(aisha, { query:id })).total,0)
    assert.equal((await domain.detail(admin,'WC-102')).canAct,true)
    const doc = await domain.document(brandon,id,id+'-extract')
    const ref = { claimId:id, claimVersion:1, documentVersion:doc.version, documentId:doc.id, anchorId:'financials' }
    assert.ok((await domain.chatSource(brandon,ref)).anchors.some(a => a.id === ref.anchorId))
    await domain.transfer(admin,id,{ recipientId:aisha.principalId, expectedVersion:1 })
    await assert.rejects(domain.chatSource(brandon,ref),{status:404})
    await assert.rejects(domain.chatSource(aisha,ref),{code:'stale_version'})
    assert.equal((await domain.chatSearch(aisha,{query:id})).total,1)
    await seed(pool,{showcase:true,cmsSnapshot})
    assert.equal((await domain.detail(admin,id)).item.ownerId,aisha.principalId)
    await domain.deliverShowcaseIntake()
    const proposal = await domain.prepare(admin,'IN-201',{action:'file_intake_transcript', expectedVersion:1,
      targetClaimId:'WC-105',evidenceId:'IN-201-call',anchorId:'worksite'})
    const review = await domain.review(admin,proposal.id,{decision:'approve',expectedVersion:1})
    assert.equal((await domain.dispatchOperation(review)).state,'confirmed')
    await seed(pool,{showcase:true})
    assert.equal((await domain.portfolioSummary(admin)).total,0)
    await assert.rejects(domain.detail(admin,id),{status:404})
  })
