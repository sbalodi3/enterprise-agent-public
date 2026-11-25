import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { createDomain, migrate, seed } from '../index.mjs'
import { normalizeChatScope } from '../chat.mjs'
import { createConversationApi } from '../../runtime/conversation-api.mjs'

const portfolio = { kind: 'portfolio' }
const claim = (id) => ({ kind: 'claim', claimIds: [id] })
const user = (id) => ({ principalId: id, tenantId: 'demo', profileId: 'claims-v1', subject: 'subject-' + id })
const alex = user('alex'), maya = user('maya')
const request = (question) => ({ requestId: randomUUID(), question })
const source = {
  claimId: 'WC-103', claimVersion: 1, documentId: 'WC-103-report', documentVersion: 1, anchorId: 'account',
}
const answer = { text: 'The report records November 9.', sources: [source] }

test('narrow scopes cannot silently become portfolio access', () => {
  for (const scope of [null, {}, { kind: 'multi', claimIds: [] }, { kind: 'claim', claimIds: ['a','b'] }, { kind: 'portfolio', ids: ['private'] },
    { kind: 'multi', claimIds: ['a','a'] }, { kind: 'portfolio', claimIds: ['a'] }, { kind: 'document', claimIds: ['a'] },
    { kind: 'workspace', claimIds: ['a'] }, { kind: 'claim', claimIds: ['a'], documents: { b: ['e'] } },
    { kind: 'claim', claimIds: ['a'], documents: { a: [] } }]) {
    assert.throws(() => normalizeChatScope(scope), { code: 'invalid_chat_scope' })
  }
  assert.deepEqual(normalizeChatScope({ kind: 'multi', claimIds: ['b','a'] }), { kind: 'multi', claimIds: ['a','b'] })
})

test('protected conversation reads and retries in PostgreSQL', { skip: !process.env.CLAIMS_TEST_DATABASE_URL }, async (t) => {
  const url = process.env.CLAIMS_TEST_DATABASE_URL
  const schema = 'cw_chat_test_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema })
  t.after(async () => {
    await db.end()
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
    await admin.end()
  })
  // Exercise the deployed schema with an existing conversation, then upgrade it twice.
  for (const version of ['001','007'])
    await db.query(await readFile(new URL('../migrations/' + version + '.sql', import.meta.url), 'utf8'))
  const oldId = randomUUID(), oldRequest = randomUUID(), legacy = { ...alex, subject: 'pre-upgrade' }
  await db.query("INSERT INTO cw_principals VALUES('alex','demo','claims-v1','adjuster')")
  await db.query("INSERT INTO cw_chat_conversations(id,tenant,profile,actor,subject,scope) VALUES($1,'demo','claims-v1','alex',$2,$3)",
    [oldId, legacy.subject, claim('WC-103')])
  await db.query(`INSERT INTO cw_chat_turns(id,conversation_id,request_id,attempt_id,question,state,dependencies,answer,lease_until)
    VALUES($1,$2,$3,$4,'Original question','completed','[]',$5,now())`, [randomUUID(),oldId,oldRequest,randomUUID(),{ text: 'Prior answer' }])
  await migrate(db)
  await migrate(db)
  await seed(db, { showcase: true })
  const service = createDomain(db, { showcase: {} })
  const conversation = await service.openConversation(alex, claim('WC-103'))
  const portfolioChat = await service.openConversation(alex, portfolio)

  await t.test('migration retains existing conversation IDs, turn scopes and reuse', async () => {
    const old = await service.openConversation(legacy, claim('WC-103'))
    assert.equal(old.id, oldId)
    assert.equal(old.scopeRevision, 1)
    assert.deepEqual(old.turns[0].scope, old.scope)
    assert.equal(old.turns[0].requestId, oldRequest)
    assert.equal(old.turns[0].answer.text, 'Prior answer')
  })

  await t.test('an intervening native result ends previous-source and model-history continuity across replies and retries', async () => {
    const employee = {...alex,subject:'native-continuity'}
    const c = await service.openConversation(employee, portfolio, {fresh:true})
    const cohort = {kind:'portfolio',operation:'list',filters:{status:'open'}}
    const start = (text,extra={}) => service.startChatTurn(employee,c.id,{...request(text),planned:true,...extra})
    const bind = turn => service.bindTurnPlan(employee,c.id,turn.turnId,turn.attemptId,portfolio,cohort)
    const finish = turn => service.finishChatTurn(employee,c.id,turn.turnId,turn.attemptId,{answer:{text:'Synthetic result',portfolioQuery:cohort}})
    const old = await start('First protected search')
    await bind(old)
    await finish(old)
    const freshInput = {...request('New search after workspace turn'),planned:true,excludedPreviousTurnId:old.turnId}
    const fresh = await service.startChatTurn(employee,c.id,freshInput)
    assert.equal(fresh.previousPlan,undefined)
    assert.deepEqual((await bind(fresh)).modelHistory,[])
    await service.pauseChatTurn(employee,c.id,fresh.turnId,fresh.attemptId,
      {text:'Which status?',options:[{id:'open',label:'Open'}]},'planner')
    const pending = (await service.conversation(employee,c.id)).turns.at(-1).pendingQuestion
    const resumed = await service.replyChatTurn(employee,c.id,{requestId:randomUUID(),turnId:fresh.turnId,questionId:pending.id,
      expectedRevision:1,answer:{selected:['open']}})
    assert.equal(resumed.previousPlan,undefined)
    assert.deepEqual((await bind(resumed)).modelHistory,[])
    await service.failChatTurn(employee,c.id,resumed.turnId,resumed.attemptId,'turn_interrupted')
    const retry = await service.startChatTurn(employee,c.id,{...freshInput,excludedPreviousTurnId:undefined})
    assert.equal(retry.previousPlan,undefined)
    assert.deepEqual((await bind(retry)).modelHistory,[])
    await finish(retry)
    const followup = await start('Follow up on the new result',{excludedPreviousTurnId:old.turnId})
    assert.deepEqual(followup.previousPlan,cohort)
    assert.deepEqual((await bind(followup)).modelHistory.map(t=>t.id),[fresh.turnId])
    assert.equal((await service.conversation(employee,c.id)).turns.length,3)
  })

  await t.test('protected clarification continues the original turn once, without losing pins or mixing evidence', async () => {
    const employee = { ...alex, subject: 'planned-request' }
    const pin = claim('WC-103'), target = claim('WC-104')
    const c = await service.openConversation(employee, pin, { fresh: true })
    const pending = []
    const source = { claimId: 'WC-104', claimVersion: 1, title: 'Diary review' }
    const rejected = { claimId: 'WC-106', claimVersion: 1, title: 'Supervisor statement' }
    const rejectedDocument = { claimId:'WC-103', claimVersion:1, documentId:'WC-103-shift', documentVersion:1, title:'Shift handover note' }
    const asked = []
    const api = createConversationApi({
      domain: service,
      auth: { admit: () => ({ peer: { signal: new AbortController().signal } }), require: () => employee },
      trace: { run(_name, fn) { const completed = fn(); pending.push(completed); return completed } },
      async planTurn({ question, pins, focus, excludedClaimIds, excludedDocumentIds, chooseCandidate, correction }) {
        assert.deepEqual(pins, pin)
        if (question === 'List my claims') return { scope: portfolio, operation: { kind: 'portfolio', operation:'list' } }
        if (question === 'Explain this claim') {
          assert.deepEqual(focus, target)
          return { scope: focus, operation: { kind: 'claim' } }
        }
        if (chooseCandidate) {
          assert.equal(chooseCandidate.claimId, target.claimIds[0])
          return { scope: target, focus: target, operation: { kind: 'claim' } }
        }
        const candidate = !excludedDocumentIds.length ? rejectedDocument : excludedClaimIds.includes(rejected.claimId) ? source : rejected
        if (candidate === source) assert.equal(correction, 'the diary review')
        return { question: { kind: 'candidate', text: candidate.title + '?', options: [{id:'yes',label:'Yes'},{id:'no',label:'No'}], candidate } }
      },
      async runTurn({ question, scope, history, clarifications }) {
        asked.push({ question, scope, history, clarifications })
        if (question === 'Review that claim' && !clarifications.length) return {
          pendingQuestion: { text:'Which detail?', options:[{id:'status',label:'Status'}] }, dependencies: [source],
        }
        return { text: question, sources: [], dependencies: [] }
      },
    })
    async function snapshot() { return service.conversation(employee, c.id) }
    async function post(path, body) {
      const receipt = await api({method:'POST'}, {}, employee, path + '/' + c.id, body, new URLSearchParams())
      await Promise.all(pending.splice(0))
      return receipt
    }
    const input = { ...request('Review that claim'), expectedRevision:1, planned:true }
    const { turnId } = await post('turn', input)
    async function current() { return (await snapshot()).turns.find(t => t.id === turnId) }
    const first = await current()
    assert.equal(first.state, 'awaiting_input')
    assert.equal(first.pendingQuestion.question, rejectedDocument.title + '?')
    assert.equal(first.pendingQuestion.candidate, undefined)
    await db.query("UPDATE cw_chat_turns SET lease_until=now()-interval '1 day' WHERE id=$1", [turnId])
    assert.equal((await current()).state, 'awaiting_input')
    assert.equal((await post('turn', input)).turnId, turnId)
    await assert.rejects(post('turn', { ...input, requestId:randomUUID() }), { code:'chat_turn_busy' })
    await assert.rejects(service.updateChatScope(employee, c.id, target, 1), { code:'chat_turn_busy' })
    const reply = (q, value) => ({ turnId, questionId:q.id, expectedRevision:1, requestId:randomUUID(), answer:value })
    await post('reply', reply(first.pendingQuestion, {selected:['no']}))
    const alternate = await current()
    assert.equal(alternate.pendingQuestion.question, rejected.title + '?')
    const other = reply(alternate.pendingQuestion, {selected:[],custom:'the diary review'})
    await post('turn', {kind:'reply', ...other})
    await post('reply', other)
    const second = await current()
    assert.equal(second.pendingQuestion.question, source.title + '?')
    await assert.rejects(post('reply', { ...other, answer:{selected:['yes']} }), { code:'question_already_answered' })
    await assert.rejects(service.replyChatTurn(maya, c.id, reply(second.pendingQuestion, {selected:['yes']})), { status:404 })
    const yes = reply(second.pendingQuestion, { selected:['yes'] })
    await Promise.all([post('reply', yes), post('reply', yes)])
    const generic = await current()
    assert.equal(generic.pendingQuestion.question, 'Which detail?')
    assert.deepEqual((await snapshot()).scope, pin)
    assert.deepEqual((await snapshot()).focus, target)
    await post('reply', reply(generic.pendingQuestion, {selected:['status']}))
    assert.equal((await current()).state, 'completed')
    const answered = (await current()).clarifications
    assert.deepEqual(answered.map(r => r.answer), [{selected:['no']},{selected:[],custom:'the diary review'},{selected:['yes']},{selected:['status']}])
    assert.equal(answered[0].question.candidate, undefined)
    assert.equal(asked.length, 2)
    assert.equal(asked[1].clarifications[0].answer.selected[0], 'status')
    await assert.rejects(post('turn', { ...input, ...request('Explain this claim'), expectedFocus:null }), { code:'scope_changed' })
    assert.equal((await post('turn', { ...input, expectedFocus:null })).turnId, turnId)
    await post('turn', { ...input, ...request('List my claims') })
    assert.deepEqual(asked.at(-1).history, [])
    await post('turn', { ...input, ...request('Explain this claim') })
    assert.deepEqual(asked.at(-1).history.map(t => t.question), ['Review that claim'])
    assert.equal(asked.at(-1).history[0].clarifications, undefined)
    assert.equal((await snapshot()).turns.length, 3)
    const reset = await service.updateChatScope(employee, c.id, pin, 1, true)
    assert.deepEqual(reset.focus, pin)
    assert.equal(reset.scopeRevision, 2)
  })

  await t.test('a transferred pending candidate is hidden and the employee can cancel the unresolved request', async () => {
    const employee = { ...maya, subject: 'revoked-candidate' }
    const c = await service.openConversation(employee, portfolio, { fresh: true })
    const turn = await service.startChatTurn(employee, c.id, { ...request('Find a case'), expectedRevision:1, planned:true })
    const candidate = { claimId:'WC-103', claimVersion:1, title:'Protected title' }
    await db.query("INSERT INTO cw_readers VALUES('WC-103','maya')")
    await service.pauseChatTurn(employee, c.id, turn.turnId, turn.attemptId,
      {kind:'candidate',text:'Protected title?',candidate,options:[{id:'yes',label:'Yes'}]}, 'planner')
    await db.query("DELETE FROM cw_readers WHERE item_id='WC-103' AND principal_id='maya'")
    const [hidden] = (await service.conversation(employee, c.id)).turns
    assert.equal(hidden.pendingQuestion.kind, 'unavailable')
    assert.equal(JSON.stringify(hidden).includes('Protected title'), false)
    const input = {turnId:turn.turnId,questionId:hidden.pendingQuestion.id,requestId:randomUUID(),expectedRevision:1}
    await assert.rejects(service.replyChatTurn(employee,c.id,{...input,answer:{selected:['yes']}}), {status:404})
    await service.replyChatTurn(employee,c.id,{...input,cancel:true})
    assert.equal((await service.conversation(employee,c.id)).turns[0].state, 'cancelled')
  })

  await t.test('search and nested inventories show only assignments and explicit shares including closed claims', async () => {
    const supervisor = user('supervisor')
    assert.equal((await service.chatSearch(supervisor, { status: 'all' })).total, 0)
    assert.deepEqual((await service.chatSearch(maya, { status: 'closed' })).items.map(i => [i.id, i.lifecycle]), [['WC-113', 'closed']])
    assert.equal((await service.chatSearch(alex, { status: 'all' })).total, 7)
    assert.throws(() => service.chatSearch(maya, { status: 'unknown' }), { code: 'invalid_claim_search' })
    await assert.rejects(service.chatDocuments(supervisor, 'WC-103'), { status: 404 })
    await assert.rejects(service.chatDocuments(maya, 'IN-202'), { status: 404 })
    await db.query("INSERT INTO cw_readers VALUES('WC-103','supervisor')")
    assert.equal((await service.chatSearch(supervisor)).items[0].id, 'WC-103')
    const nested = await service.chatDocuments(supervisor, 'WC-103')
    assert.equal(nested.claimVersion, 1)
    assert.deepEqual(nested.items.map(d => d.id).sort(), ['WC-103-report','WC-103-shift'])
    assert.deepEqual(Object.keys(nested.items[0]).sort(), ['id','kind','title','version'])
    await db.query("DELETE FROM cw_readers WHERE item_id='WC-103' AND principal_id='supervisor'")
    await assert.rejects(service.chatDocuments(supervisor, 'WC-103'), { status: 404 })
    await assert.rejects(service.chatSource(supervisor, source), { status: 404 })
  })

  await t.test('fresh conversations, nested scope edits, concurrent writers and guarded per-turn history', async () => {
    const person = { ...alex, subject: 'scope-editor' }
    const first = await service.openConversation(person, { kind: 'workspace' }, { fresh: true })
    const second = await service.openConversation(person, { kind: 'workspace' }, { fresh: true })
    assert.notEqual(first.id, second.id)
    await assert.rejects(service.startChatTurn(person, first.id, request('Empty scope')), { code: 'select_claim_scope' })
    const full = await service.updateChatScope(person, first.id, claim('WC-103'), 1)
    const req = { ...request('Compare the shift handover and report.'), expectedRevision: full.scopeRevision }
    const turn = await service.startChatTurn(person, first.id, req)
    const subset = { kind: 'multi', claimIds: ['WC-103','WC-104'], documents: { 'WC-103': ['WC-103-shift'] } }
    await assert.rejects(service.updateChatScope(person, first.id, subset, full.scopeRevision), { code: 'chat_turn_busy' })
    await service.finishChatTurn(person, first.id, turn.turnId, turn.attemptId, { answer, dependencies: [source] })
    const writes = await Promise.allSettled([1,2].map(() => service.updateChatScope(person, first.id, subset, full.scopeRevision)))
    assert.equal(writes.filter(v => v.status === 'fulfilled').length, 1)
    assert.equal(writes.find(v => v.status === 'rejected').reason.code, 'scope_changed')
    const revised = writes.find(v => v.status === 'fulfilled').value
    const { item, documents } = await service.chatEvidenceIndex(person, subset, 'WC-103')
    assert.deepEqual(item, { version: 1 })
    assert.deepEqual(documents.map(d => d.id), ['WC-103-shift'])
    assert.deepEqual(Object.keys(documents[0].anchors[0]).sort(), ['id','label'])
    assert.throws(() => service.chatEvidenceIndex(person, subset, 'WC-105'), { status: 404 })
    assert.deepEqual(revised.turns[0].scope, full.scope)
    assert.equal((await service.citedChatSource(person, first.id, source)).id, 'WC-103-report')
    await assert.rejects(service.updateChatScope(person, first.id, { ...subset, documents: { 'WC-103': ['WC-104-report'] } },
      revised.scopeRevision), { status: 404 })
    await assert.rejects(service.startChatTurn(person, first.id, req), { code: 'scope_changed' })
    await assert.rejects(service.startChatTurn(person, first.id, request('Stale client')), { code: 'scope_changed' })
    const freshTurn = await service.startChatTurn(person, first.id, { ...request('Read selected documents.'), expectedRevision: revised.scopeRevision })
    assert.deepEqual(freshTurn.modelHistory, [])
    assert.equal(freshTurn.dependencies.some(d => d.documentId === 'WC-103-report'), false)
    await assert.rejects(service.finishChatTurn(person, first.id, freshTurn.turnId, freshTurn.attemptId,
      { answer, dependencies: [source] }), { status: 404 })
    await assert.rejects(service.finishChatTurn(person, first.id, freshTurn.turnId, freshTurn.attemptId, { answer }), { status: 404 })
    await service.failChatTurn(person, first.id, freshTurn.turnId, freshTurn.attemptId, 'test_interruption')
    await assert.rejects(service.startChatTurn(person, first.id, { ...req, expectedRevision: revised.scopeRevision }), { code: 'request_id_conflict' })
    const cleared = await service.updateChatScope(person, first.id, { kind: 'workspace' }, revised.scopeRevision)
    assert.deepEqual(cleared.scope, { kind: 'workspace' })
    await assert.rejects(service.startChatTurn(person, first.id, { ...request('Read'), expectedRevision: cleared.scopeRevision }), { code: 'select_claim_scope' })
    assert.deepEqual((await service.conversation(person, second.id)).turns, [])
  })

  await t.test('authorized scope, pure search, pinned sources and scoped document reads', async () => {
    const res = await service.chatSearch(alex, { dueToday: true, assignedOnly: true, limit: 1 })
    assert.equal(res.total, 2)
    assert.equal(res.items[0].id, 'WC-108')
    assert.deepEqual(res.dependencies.map(d => d.claimId), ['WC-108', 'WC-104'])
    assert.equal((await service.chatSearch(alex, { dueToday: true, assignedOnly: true, offset: 1 })).items[0].id, 'WC-104')
    assert.equal((await db.query('SELECT 1 FROM cw_decisions')).rowCount, 0)
    assert.equal((await service.chatSearch(maya, { query: 'WC-103' })).total, 0)
    assert.equal((await service.chatSearch(alex)).total, 6)
    assert.equal((await service.openConversation(alex, claim('WC-103'))).id, conversation.id)
    await assert.rejects(service.openConversation(maya, claim('WC-103')), { status: 404 })
    await assert.rejects(service.conversation(maya, conversation.id), { status: 404 })
    await assert.rejects(service.conversation({ ...alex, subject: 'different' }, conversation.id), { status: 404 })
    assert.equal((await service.chatSource(alex, source)).id, 'WC-103-report')
    await assert.rejects(service.chatSource(alex, { ...source, anchorId: 'unlisted' }), { status: 404 })
    await assert.rejects(service.chatSource(alex, { ...source, documentVersion: 2 }), { code: 'stale_version' })
    await assert.rejects(service.chatSource(maya, source), { status: 404 })
    const doc = { kind: 'document', claimIds: ['WC-103'], documentId: 'WC-103-shift' }
    await assert.rejects(service.assertChatScope(alex, doc, [source]), { status: 404 })
    await assert.rejects(service.assertChatScope(alex, portfolio, [source]), { status: 404 })
    await assert.rejects(service.openConversation(alex, { ...doc, documentId: 'WC-104-report' }), { status: 404 })
  })

  await t.test('simultaneous submissions, deduplicated delivery, attempts and lease fencing', async () => {
    const input = request('Why do the dates disagree?')
    const calls = await Promise.all([1, 2].map(() => service.startChatTurn(alex, conversation.id, input)))
    const first = calls.find(v => v.started)
    assert.equal(calls.filter(v => v.started).length, 1)
    assert.equal(calls[0].turnId, calls[1].turnId)
    await assert.rejects(service.startChatTurn(alex, conversation.id, { ...input, question: 'other' }), { code: 'request_id_conflict' })
    await assert.rejects(service.startChatTurn(alex, conversation.id, request('another')), { code: 'chat_turn_busy' })
    const progress = [{ id: '1', label: 'Read supervisor report', state: 'completed' }]
    await service.setChatActivity(alex, conversation.id, first.turnId, first.attemptId, progress, [source])
    assert.deepEqual((await service.conversation(alex, conversation.id)).turns[0].activity, progress)
    await db.query("UPDATE cw_chat_turns SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1", [first.turnId])
    assert.equal((await service.conversation(alex, conversation.id)).turns[0].error, 'turn_interrupted')
    const retry = await service.startChatTurn(alex, conversation.id, input)
    assert.equal(retry.turnId, first.turnId)
    assert.notEqual(retry.attemptId, first.attemptId)
    const result = { answer, activity: progress, dependencies: [source] }
    await assert.rejects(service.finishChatTurn(alex, conversation.id, first.turnId, first.attemptId, result), { code: 'turn_no_longer_active' })
    await service.failChatTurn(alex, conversation.id, first.turnId, first.attemptId, 'old_error')
    await service.finishChatTurn(alex, conversation.id, retry.turnId, retry.attemptId, result)
    const duplicate = await service.startChatTurn(alex, conversation.id, input)
    assert.equal(duplicate.started, false)
    assert.deepEqual(duplicate.conversation.turns.map(t => t.answer), [answer])
    assert.equal(duplicate.dependencies.some(d => d.documentId === source.documentId), true)
    assert.equal((await service.citedChatSource(alex, conversation.id, source)).id, source.documentId)
    await assert.rejects(service.citedChatSource(alex, conversation.id, { ...source, anchorId: 'followup' }), { status: 404 })
    await assert.rejects(service.citedChatSource(maya, conversation.id, source), { status: 404 })
  })

  await t.test('source version change expires old history and prevents completion on the old read', async () => {
    const turn = await service.startChatTurn(alex, conversation.id, request('Summarize the report again.'))
    await db.query("UPDATE cw_evidence SET document=jsonb_set(document,'{version}','2') WHERE id=$1", [source.documentId])
    const history = await service.conversation(alex, conversation.id)
    assert.equal(history.turns[0].state, 'stale')
    assert.equal(history.turns[0].answer, undefined)
    await assert.rejects(service.citedChatSource(alex, conversation.id, source), { code: 'stale_version' })
    await assert.rejects(service.finishChatTurn(alex, conversation.id, turn.turnId, turn.attemptId, { answer }), { code: 'stale_version' })
    await service.failChatTurn(alex, conversation.id, turn.turnId, turn.attemptId, 'stale_version')
    await assert.rejects(service.chatSource(alex, source), { code: 'stale_version' })
  })

  await t.test('live cards query newly matching assignments even when no previous dependency changes', async () => {
    const person = { ...maya, subject: 'card-view' }
    const thread = await service.openConversation(person, portfolio)
    const search = await service.chatSearch(person, { assignedOnly: true, waitingOnly: true })
    const turn = await service.startChatTurn(person, thread.id, request('Which of my cases are waiting?'))
    await service.finishChatTurn(person, thread.id, turn.turnId, turn.attemptId, {
      answer: { cases: { view: 'waiting' }, text: 'Original waiting list.' }, dependencies: search.dependencies,
    })
    const before = (await service.conversation(person, thread.id)).turns[0].cases
    assert.equal(before.total, search.total)
    await db.query("UPDATE cw_items SET state='waiting', version=version+1 WHERE id='WC-101'")
    const after = (await service.conversation(person, thread.id)).turns[0].cases
    assert.equal(after.total, before.total + 1)
    assert.ok(after.items.some(item => item.id === 'WC-101'))
    await db.query("UPDATE cw_items SET lifecycle='closed', version=version+1 WHERE id='WC-101'")
    assert.deepEqual((await service.conversation(person, thread.id)).turns[0].cases, before)
    await db.query(`INSERT INTO cw_items(id,tenant,profile,owner_id,type,title,state,reason,next_action,as_of,source)
      SELECT 'card-test-' || n,tenant,profile,owner_id,type,title,'waiting',reason,next_action,as_of,source
      FROM cw_items CROSS JOIN generate_series(1,13) n WHERE id='WC-101'`)
    const page = (await service.conversation(person, thread.id)).turns[0].cases
    assert.equal(page.items.length, 12)
    assert.equal(page.total, before.total + 13)
    await db.query("DELETE FROM cw_items WHERE id LIKE 'card-test-%'")
  })

  await t.test('portfolio cohorts and multi-claim answers recheck visibility before resume, selection never widens', async () => {
    const multi = await service.openConversation(alex, { kind: 'multi', claimIds: ['WC-104', 'WC-103'] })
    const selection = await service.openConversation(alex, { kind: 'multi', claimIds: ['WC-103', 'WC-104'] })
    assert.equal(multi.id, selection.id)
    const cohort = await service.chatSearch(alex, { assignedOnly: true, limit: 1 })
    const portfolioTurn = await service.startChatTurn(alex, portfolioChat.id, request('How many claims?'))
    await service.finishChatTurn(alex, portfolioChat.id, portfolioTurn.turnId, portfolioTurn.attemptId, {
      answer: { text: 'Six assigned.' }, dependencies: cohort.dependencies,
    })
    const cardOwner = { ...alex, subject: 'open-card' }
    const cardThread = await service.openConversation(cardOwner, portfolio)
    const cardTurn = await service.startChatTurn(cardOwner, cardThread.id, request('What are my open cases?'))
    await service.finishChatTurn(cardOwner, cardThread.id, cardTurn.turnId, cardTurn.attemptId, {
      answer: { cases: { view: 'open' }, text: 'Original open cases.' }, dependencies: cohort.dependencies,
    })
    const held = await service.startChatTurn(alex, multi.id, request('Compare the files'))
    await service.transfer(alex, 'WC-103', { expectedVersion: 1, recipientId: 'maya' })
    await assert.rejects(service.finishChatTurn(alex, multi.id, held.turnId, held.attemptId, { answer }), { status: 404 })
    await assert.rejects(service.conversation(alex, conversation.id), { status: 404 })
    const card = (await service.conversation(cardOwner, cardThread.id)).turns[0]
    assert.equal(card.state, 'unavailable')
    assert.equal(card.answer, undefined)
    assert.equal(card.question, undefined)
    assert.equal(card.cases.total, 5)
    assert.equal(card.cases.items.some(i => i.id === 'WC-103'), false)
    await assert.rejects(service.conversation(alex, multi.id), { status: 404 })
    await assert.rejects(service.conversation(maya, conversation.id), { status: 404 })
    assert.deepEqual((await service.chatConversations(alex)).items.map(i => i.id), [portfolioChat.id])
    const editor = { ...alex, subject: 'scope-editor' }
    const edited = (await service.chatConversations(editor)).items
    const histories = await Promise.all(edited.map(c => service.conversation(editor, c.id)))
    const old = histories.find(c => c.turns.length)
    assert.deepEqual(old.scope, { kind: 'workspace' })
    assert.deepEqual(old.turns[0], { id: old.turns[0].id, state: 'unavailable' })
    await assert.rejects(service.citedChatSource(editor, old.id, source), { status: 404 })
    const resumed = await service.startChatTurn(alex, portfolioChat.id, request('What about now?'))
    assert.deepEqual(resumed.dependencies, [])
    assert.deepEqual(resumed.conversation.turns, [{ id: portfolioTurn.turnId, state: 'unavailable' }])
    assert.equal((await service.chatSearch(alex, { assignedOnly: true })).total, 5)
  })
})
