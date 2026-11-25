import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { createDomain, migrate, seed } from '../index.mjs'
import { planClaimRequest } from '../../runtime/scope-router.mjs'

const ctx = {tenantId:'demo',profileId:'claims-v1',principalId:'alex',subject:'target-test'}
test('discovery verifies complete authorized matches, closed claims, document subsets and rejections', {skip:!process.env.CLAIMS_TEST_DATABASE_URL}, async t => {
  const schema = 'cw_target_' + randomUUID().replaceAll('-','')
  const admin = new pg.Pool({connectionString:process.env.CLAIMS_TEST_DATABASE_URL})
  const pool = new pg.Pool({connectionString:process.env.CLAIMS_TEST_DATABASE_URL,options:'-c search_path='+schema})
  await admin.query('CREATE SCHEMA '+schema)
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end() })
  await migrate(pool)
  await seed(pool,{showcase:true})
  const domain = createDomain(pool,{showcase:{}})
  const plan = (question, options={}) => planClaimRequest({domain,ctx,question,...options})
  const a = {kind:'claim',claimIds:['WC-103']}
  const b = {kind:'claim',claimIds:['WC-114']}
  await pool.query(`INSERT INTO cw_items(id,tenant,profile,owner_id,type,title,state,reason,next_action,as_of,source)
    SELECT 'WC-'||n,'demo','claims-v1','alex','claim','Garage record '||n,'ready','Inspection','Review',now(),'fixture'
    FROM generate_series(10000,10505) n`)
  assert.deepEqual((await plan('Open WC-114',{pins:a,focus:a})).focus,b)
  assert.deepEqual((await plan('What is its next step?',{pins:a,focus:b})).scope,b)
  assert.deepEqual((await plan('Review the pinned claim',{pins:a,focus:b})).scope,a)
  assert.equal((await plan('Open WC-103',{ctx:{...ctx,principalId:'maya'}})).question.kind,'clarification')
  await pool.query("UPDATE cw_items SET reason='Delivery van struck playground' WHERE id='WC-103'")
  assert.deepEqual((await plan('Review the claim involving the delivery van')).focus,a)
  assert.deepEqual((await plan('What is the status of the delivery van claim?',{pins:b,focus:b})).focus,a)
  await pool.query("UPDATE cw_items SET reason='Delivery van struck rail' WHERE id='WC-114'")
  const proposal = (await plan('Review the claim involving the delivery van')).question
  assert.equal(proposal.kind,'candidate')
  assert.deepEqual(proposal.options.map(o => o.id),['yes','no'])
  assert.deepEqual((await plan('Review the claim involving the delivery van',{chooseCandidate:proposal.candidate})).scope,a)
  assert.equal((await plan('Review the claim involving the delivery van',{excludedClaimIds:['WC-103']})).question.candidate.claimId,'WC-114')
  const doc = await plan('Read the Supervisor incident report')
  assert.deepEqual(doc.scope.documents,{'WC-103':['WC-103-report']})
  const denied = await plan('Open WC-103',{excludedDocumentIds:['WC-103-report']})
  assert.equal(denied.question.kind,'clarification')
  assert.equal((await plan('Open WC-103-shift',{pins:doc.scope})).question.kind,'clarification')
  await pool.query("INSERT INTO cw_evidence(id,item_id,source,title,body,as_of) VALUES ('legacy-note','WC-103','Fixture','Legacy diary note','Recorded original.',now())")
  const legacy = createDomain(pool)
  const legacyMatch = await plan('Read Legacy diary note',{domain:legacy})
  assert.deepEqual(legacyMatch.scope.documents,{'WC-103':['legacy-note']})
  const ref = {...legacyMatch.dependencies[0],anchorId:'body'}
  assert.equal((await legacy.chatSource(ctx,ref)).anchors[0].text,'Recorded original.')
  await pool.query("UPDATE cw_items SET version=version+1 WHERE id='WC-103'")
  await assert.rejects(plan('Review the claim',{chooseCandidate:proposal.candidate}),{code:'stale_version'})
})
