import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { createDomain, migrate, seed, transaction } from '../index.mjs'
import { seedWageStudy } from '../showcase.mjs'
import { createClaimReads } from '../../runtime/chat-mcp.mjs'
import { wageAnswer } from '../../runtime/wage-review.mjs'

test('study seed, cited review, replay and reassignment in PostgreSQL', {skip: !process.env.CLAIMS_TEST_DATABASE_URL}, async t => {
  const connectionString = process.env.CLAIMS_TEST_DATABASE_URL
  const schema = 'wage_study_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  await admin.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString, options: '-c search_path=' + schema })
  t.after(async () => {
    await db.end()
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
    await admin.end()
  })
  await migrate(db)
  await seed(db, {showcase:true})
  await transaction(db, seedWageStudy)
  await transaction(db, seedWageStudy)
  assert.equal((await db.query("SELECT id FROM cw_items WHERE source='Wage evidence study'")).rowCount, 8)
  const domain = createDomain(db, {showcase:{}})
  const principal = {principalId:'maya',tenantId:'demo',profileId:'claims-v1',subject:'test-maya'}
  const scope = {kind:'claim',claimIds:['WC-957']}
  const conversation = await domain.openConversation(principal, scope)
  const turn = await domain.startChatTurn(principal, conversation.id, {requestId:randomUUID(), question:'Review wage coverage'})
  const reads = createClaimReads({domain, principal, scope, wagePilot:true, allowed:['review_wage_evidence'],
    signal:new AbortController().signal, reauthorize:deps => domain.assertChatScope(principal, scope, deps)})
  await reads.call('review_wage_evidence', {})
  const {wageReview,dependencies} = reads.state()
  const answer = wageAnswer(wageReview, null)
  await domain.finishChatTurn(principal, conversation.id, turn.turnId, turn.attemptId, {answer,dependencies})
  const saved = (await domain.conversation(principal, conversation.id)).turns[0].answer
  assert.deepEqual(saved.wageReview, answer.wageReview)
  for (const ref of saved.sources) assert.equal((await domain.citedChatSource(principal, conversation.id, ref)).id, ref.documentId)
  await db.query("UPDATE cw_items SET owner_id='alex',version=version+1 WHERE id='WC-957'")
  await assert.rejects(domain.citedChatSource(principal, conversation.id, saved.sources[0]), {status:404})
  assert.ok(!(await domain.conversation(principal, conversation.id).catch(e => { assert.equal(e.status,404); return {turns:[]} })).turns.some(t => t.answer))
})
