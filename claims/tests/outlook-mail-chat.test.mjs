import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { MailToolModel } from './outlook-model-fixture.mjs'
import { createChatHost } from './chat-host-fixture.mjs'
import { createOutlookChat, outlookIntent, ordinalOf } from '../ui/outlook-chat.mjs'
import { createMailChat, mailReads } from '../connections/mail-chat.mjs'
import { mailHistory } from '../connections/mail-history.mjs'

const principal = { tenantId: 'demo', principalId: 'maya', subject: 'subject-maya' }
const profile = { id: 'outlook-test', model: 'mail-test' }
const tz = 'America/New_York'
const fixed = Date.parse('2026-11-20T01:15:00Z')
const mail = n => ({ id: 'server-private-id-' + n, subject: 'WC-103 item ' + n, from: 'Maya', receivedAt: '2026-11-19T18:00:00Z',
  excerpt: 'Excerpt ' + n, webLink: 'https://outlook.office.com/mail/' + n })
const result = { items: [mail(2), mail(1)], partial: true }
const grant = { status: 'connected', version: 7, signal: new AbortController().signal, token: 'synthetic' }

function connections() {
  return {
    status: async () => grant,
    withAccess: (_p, _app, fn) => fn(grant),
    withOperation: (_p, _op, fn) => fn(new Map([['outlook-mail', grant]])),
    commitIfCurrent: (_p, _app, _v, fn) => fn(),
  }
}

test('clear intent, literal mentions, draft requests, mixed sources and ordinal follow-ups', () => {
  for (const text of ['Search my inbox for WC-103', 'What did Chris email me this morning?', 'Find emails with subject "WC-103"'])
    assert.equal(outlookIntent(text), 'mail', text)
  for (const text of ['Draft an email about WC-103', 'How do I search Outlook?', 'What is Outlook?', 'What should our email retention policy be?',
    'Find my local file outlook.eml', 'He said "check my inbox"'])
    assert.equal(outlookIntent(text), 'other', text)
  assert.equal(outlookIntent('draft an email', { selected: true }), 'blocked')
  assert.equal(outlookIntent('Compare my email with the claim file'), 'mixed')
  assert.equal(outlookIntent('open the second one', { previous: true }), 'mail')
  assert.equal(outlookIntent('open the second one'), 'other')
  assert.equal(ordinalOf('open the second one', 2), 1)
  assert.equal(ordinalOf('Could you please open the second one?', 2),1)
  assert.equal(ordinalOf('Read it.', 2),-1)
  assert.equal(ordinalOf('read the last message', 10), 9)
})

test('a protected composer session keeps its own result list and leaves new native sessions blank', async t => {
  const saved = new Map()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable:true,
    value:{ getItem:k => saved.get(k) || null, setItem:(k,v) => saved.set(k,v), removeItem:k => saved.delete(k) } })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis,'sessionStorage',descriptor); else delete globalThis.sessionStorage })
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({url,method:init.method})
    const input = JSON.parse(init.body)
    return Response.json({ turn: { id:input.requestId, question:input.question, answer:{ kind:'search',items:[] } } })
  })
  const mail = createOutlookChat({}, 'csrf-demo')
  assert.equal(await mail.dispatch('session-a','search my Outlook inbox',0), 'handled')
  assert.equal(mail.occupied('session-a'), true)
  assert.equal(mail.state('session-b').mailTurns, undefined)
  assert.equal(mail.occupied('session-b'), false)
  assert.equal(createOutlookChat({}, 'csrf-demo').occupied('session-a'),true)
  assert.equal(await mail.dispatch('session-a','draft an email',0),null)
  assert.equal(await mail.dispatch('session-a','open the second one',0),null)
  assert.equal(calls.filter(c => c.method === 'POST').length,1)
})

test('turn date, bounded order, typed references and exact provider data survive native projection', async () => {
  const make = (question, previous, perform) => mailReads({ question, timeZone: tz, now: fixed, previous, perform, check: async () => {} })
  let args
  const reads = make('Find latest emails from last week', [], async (_, input) => { args = input; return result })
  assert.equal(reads.day, '2026-11-19')
  await reads.call('search_outlook', { query: 'WC-103' })
  assert.deepEqual(args, {query: 'WC-103', order: 'latest', from:'2026-11-09', to:'2026-11-15', timeZone:tz})
  const saved = reads.outcome()
  assert.equal(saved.answer.partial, true)
  assert.ok(!JSON.stringify(saved.answer).includes('server-private-id'))
  assert.deepEqual(saved.answer.items.map(r => r.subject), ['WC-103 item 2','WC-103 item 1'])
  const listOnly = await reads.call('read_outlook_message', {ref:saved.refs[0].ref})
  assert.equal(listOnly.structuredContent.kind,'search')
  assert.equal(reads.outcome().answer.kind,'search')
  let opened
  const next = make('open the second one', saved.refs, async (_, id) => { opened=id; return { ...mail(1), text: 'Selected body' } })
  await assert.rejects(() => next.call('read_outlook_message', { ref: saved.refs[0].ref }), {code:'mail_reference_missing'})
  await next.call('read_outlook_message', { ref: saved.refs[1].ref })
  assert.equal(opened, mail(1).id)
  assert.equal(next.outcome().answer.text, 'Selected body')
  assert.throws(() => make('Open the third one', saved.refs), {code:'mail_reference_missing'})
  await assert.rejects(() => reads.call('read_outlook_message', { ref: mail(1).id }), {code:'mail_reference_missing'})
})

test('explicit dates override recent and incorrect model ranges, while recent alone covers 30 local calendar days', async () => {
  async function inputFor(question, args) {
    let called
    const reads = mailReads({ question, timeZone: tz, now: fixed, previous: [], check: async () => {},
      perform: async (_, input) => { called = input; return result } })
    await reads.call('search_outlook',args)
    return called
  }
  const explicit = await inputFor('Search recent emails from 2026-10-03 through 2026-10-05 about WC-103',
    {recent:true, from:'2026-11-01'})
  assert.equal(explicit.query,'WC-103')
  assert.equal(explicit.from,'2026-10-03')
  assert.equal(explicit.to,'2026-10-05')
  const recent = await inputFor('search recent emails from Maya',{sender:'Maya', from:'2026-11-12'})
  assert.equal(recent.recent,true)
  assert.equal(recent.from,undefined)
  const outside = await inputFor('Check my inbox before 2026-11-01',{from:'2026-10-25'})
  assert.equal(outside.from,undefined)
  assert.equal(outside.to,'2026-10-31')
  assert.deepEqual(await inputFor('Search my Outlook email for Westfield',{subject:'Westfield',order:'latest',from:'2026-11-01',recent:true}),
    {query:'Westfield',order:'best',timeZone:tz})
  assert.equal((await inputFor('Show the most recent email about Westfield',{order:'best'})).order,'latest')
  const cms = 'Search my inbox for CLM-000020'
  assert.equal((await inputFor(cms, {})).query, 'CLM-000020')
  assert.equal((await inputFor(cms, { query: 'clm-000020' })).query, 'clm-000020')
  assert.equal((await inputFor(cms, { query: 'CLM-0000201' })).query, 'CLM-0000201 CLM-000020')
})

test('employee turns use native MCP discovery and follow prior ordered handles through search and read', async t => {
  const ctx = await createChatHost(t, profile)
  const model = new MailToolModel()
  ctx.llm.registerAdapter(['claims-local'], model)
  let previous = [], allowed = true
  const calls = []
  const history = { start: async () => ({ attempt:'test',previous }), finish: async (_p,_s,_i,_a,answer,refs) => {
    if (answer?.kind === 'search') previous=refs
  }, list: async () => [] }
  const connect = connections()
  connect.status = async () => allowed ? grant : {status:'off', version:8}
  const handle = createMailChat({ctx, profile, history, connections:connect,
    search:async (_, query) => { calls.push(query); return result },
    read:async (_, id) => { calls.push(id); return {...mail(1), text:'Reply from Monday'} } })
  const post = question => handle({principal, path:'session-demo', method:'POST', input:{question,selected:false,timeZone:tz,requestId:randomUUID()},
    reauthorize:async () => {} })
  const list = await post('find emails for WC-103')
  assert.equal(list.turn.answer.items.length,2)
  const opened = await post('open the second one')
  assert.equal(opened.turn.answer.text,'Reply from Monday')
  assert.equal(calls[1], mail(1).id)
  assert.ok(model.seen.every(names => names.every(name => /^mcp__outlook__(read_outlook_message|search_outlook)$/.test(name)) && names.length === 2))
  const summaryOf=randomUUID()
  history.turn=async(actor,session,id)=>{
    assert.equal(actor.principalId,principal.principalId)
    assert.equal(session,'session-demo')
    assert.equal(id,summaryOf)
    return {answer:opened.turn.answer,version:String(grant.version)}
  }
  const summarize=()=>handle({principal,path:'session-demo',method:'POST',input:{summaryOf},reauthorize:async()=>{}})
  assert.deepEqual(await summarize(),{summary:'Employer confirmed a callback on Monday.'})
  assert.deepEqual(model.seen.at(-1),[])
  history.turn=async()=>({answer:list.turn.answer,version:grant.version})
  await assert.rejects(summarize,{code:'mail_reference_missing'})
  history.turn=async()=>({answer:opened.turn.answer,version:grant.version-1})
  await assert.rejects(summarize,{code:'mail_reference_missing'})
  await assert.rejects(() => post('Draft an email to Maya'), {code:'mail_read_only'})
  allowed=false
  await assert.rejects(() => post('search my inbox'), {code:'outlook_not_connected'})
  assert.equal(calls.length,2)
})
test('a revoked grant prevents a completed model turn from entering the employee transcript', async () => {
  const connect = connections(), states = []
  connect.commitIfCurrent = async () => { throw Object.assign(new Error(), {code:'microsoft_connection_changed'}) }
  const history = { start: async () => ({attempt:'test',previous:[]}), finish: async (_p,_s,_i,_a,answer) => states.push(answer) }
  const handle = createMailChat({history, connections:connect, runAgent:async ({reads}) => reads.call('search_outlook', {query:'WC-103'}), search:async () => result })
  await assert.rejects(() => handle({principal,path:'session-demo',method:'POST',input:{question:'Search Outlook',selected:false,timeZone:tz,requestId:randomUUID()},reauthorize:async () => {}}),
    {code:'microsoft_connection_changed'})
  assert.deepEqual(states,[null])
})
test('durable mail history isolates employees, replays requests, and invalidates read handles on reconnect', { skip: !process.env.CLAIMS_TEST_DATABASE_URL }, async t => {
  const url = process.env.CLAIMS_TEST_DATABASE_URL
  const schema = 'mail_turn_test_' + randomUUID().replaceAll('-',''), admin = new pg.Pool({connectionString:url})
  await admin.query('CREATE SCHEMA '+schema)
  const db = new pg.Pool({connectionString:url, options:'-c search_path='+schema})
  t.after(async () => { await db.end(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end() })
  await db.query(await readFile(new URL('../domain/migrations/013.sql', import.meta.url), 'utf8'))
  const history = mailHistory(db), session='session-one', request=randomUUID()
  const started = await history.start(principal,session,request,'Search Outlook',1)
  await assert.rejects(() => history.start(principal,session,randomUUID(),'Other search',1), {code:'mail_turn_busy'})
  const refs=[{id:'id',ref:randomUUID(),subject:'A'}], answer={kind:'search',items:[],text:'Search'}
  await history.finish(principal,session,request,started.attempt,answer,refs)
  assert.deepEqual((await history.start(principal,session,request,'Search Outlook',1)).answer,answer)
  await assert.rejects(() => history.start(principal,session,request,'changed',1),{code:'mail_request_conflict'})
  assert.deepEqual(await history.list({...principal,subject:'another'},session),[])
  const readId=randomUUID(), read=await history.start(principal,session,readId,'Open the first',1)
  assert.deepEqual(read.previous,refs)
  await history.finish(principal,session,readId,read.attempt,null)
  const freshId = randomUUID(), fresh = await history.start(principal,session,freshId,'Search for something else',1)
  await history.finish(principal,session,freshId,fresh.attempt,answer,[{id:'other',ref:randomUUID(),subject:'B'}])
  const clickId = randomUUID(), click = await history.start(principal,session,clickId,'Read this Outlook message.',1,refs[0].ref)
  assert.deepEqual(click.previous,refs)
  await history.finish(principal,session,clickId,click.attempt,null)
  await assert.rejects(() => history.start(principal,session,randomUUID(),'Read this Outlook message.',2,refs[0].ref), {code:'mail_reference_missing'})
  const next=await history.start(principal,session,randomUUID(),'Search Outlook',2)
  assert.deepEqual(next.previous,[])
  const delivered=await history.list(principal,session)
  assert.equal(delivered.length,2)
  assert.equal(delivered[0].answer.text,'Search')
  assert.equal((await history.list(principal,session,delivered[1].id))[0].id,request)
})
