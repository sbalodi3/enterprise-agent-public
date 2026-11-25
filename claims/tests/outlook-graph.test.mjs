import assert from 'node:assert/strict'
import test from 'node:test'
import { mailDateRange, readOutlook, searchOutlook } from '../connections/graph.mjs'

const lease = { token: 'synthetic-outlook-token', check: async () => {}, signal: new AbortController().signal }
const hit = (id, subject, date, extra = {}) => ({ id, subject, receivedDateTime: date,
  from: { emailAddress: { address: 'payroll@example.test' } }, bodyPreview: subject,
  webLink: 'https://outlook.office.com/mail/id/' + id, ...extra })

test('latest by topic uses the received-time Graph Search contract, even for an old message delivered today', async () => {
  const calls = []
  const messages = [
    hit('delayed','Westfield', '2026-11-20T13:00:00Z',{ sentDateTime:'2026-10-01T09:00:00Z' }),
    hit('quick','Westfield', '2026-11-19T23:59:00Z',{ sentDateTime:'2026-11-19T23:58:00Z' }),
  ]
  const answer = await searchOutlook(lease, { query:'Westfield', order:'latest' }, { fetch: async (url, init) => {
    calls.push(url.pathname)
    assert.equal(init.method,'POST')
    const [request] = JSON.parse(init.body).requests
    assert.equal(request.enableTopResults,false)
    assert.deepEqual(request.entityTypes,['message'])
    assert.equal(request.query.queryString,'"Westfield"')
    return Response.json({ value: [{ hitsContainers: [{ total: 2, moreResultsAvailable: false,
      hits: messages.map(m => ({ hitId:m.id, resource:m })) }] }] })
  } })
  assert.deepEqual(calls, ['/v1.0/search/query'])
  assert.deepEqual(answer.items.map(m => m.id), ['delayed','quick'])
})
test('latest never substitutes a collection search when Microsoft Search is unavailable', async () => {
  await assert.rejects(searchOutlook(lease, { query:'payroll', order:'latest' }, {
    fetch: async url => { assert.equal(url.pathname,'/v1.0/search/query'); return new Response('',{ status:503 }) }
  }), { status:502 })
})
test('30 employee-local calendar days including today, explicit dates win, DST and one-sided bounds', () => {
  const timeZone = 'America/New_York', now = Date.parse('2026-03-09T00:30:00Z')
  assert.deepEqual(mailDateRange({ recent:true,timeZone }, now), { from:'2026-02-07', to:'2026-03-08',timeZone,
    start:'2026-02-07T05:00:00.000Z', end:'2026-03-09T04:00:00.000Z' })
  assert.deepEqual(mailDateRange({ recent:true,timeZone,to:'2026-11-01' }, now), { from:null,to:'2026-11-01',timeZone,
    start:null,end:'2026-11-02T05:00:00.000Z' })
  assert.throws(() => mailDateRange({ from:'2026-02-30' }), { code:'invalid_mail_search' })
})
test('best match prioritizes exact subject, then recency, dedupes, and reports capped results', async () => {
  let fetches = 0
  const exact = hit('exact', 'WC-103', '2025-01-01T00:00:00Z')
  const weak = hit('weak', 'WC-1034', '2026-11-20T00:00:00Z')
  const newer = hit('newer', 'RE: WC-103', '2026-10-11T00:00:00Z')
  const response = await searchOutlook(lease,{query:'WC-103'}, {fetch: async (u, init) => {
    assert.equal(init.headers.authorization, 'Bearer synthetic-outlook-token')
    if (!u.searchParams.has('$skip')) assert.equal(u.searchParams.get('$top'),'50')
    ++fetches
    const query = u.searchParams.get('$skip')
    return Response.json(query ? {value:[newer, exact]} : {value: [weak,exact], '@odata.nextLink':'/v1.0/me/messages?$skip=2'})
  }})
  assert.equal(fetches,2)
  assert.deepEqual(response.items.map(m => m.id),['newer','exact','weak'])
  assert.equal(response.partial,false)
  const capped = await searchOutlook(lease, {query:'WC-103'}, { fetch: async () => Response.json({
    value: Array.from({length:50},(_,i) => ({...exact,id:String(i)})), '@odata.nextLink':'/v1.0/me/messages?$skip=50' }) })
  assert.equal(capped.partial,true)
  assert.equal(capped.items.length,10)
})
test('search sends typed filters and returns only results inside local dates and exact sender restriction', async () => {
  const items = [
    hit('prior', 'Update','2026-11-01T03:59:59Z'), hit('today','Update','2026-11-02T04:59:59Z'),
    hit('next','Update','2026-11-02T05:00:00Z'), hit('other','Update','2026-11-01T20:00:00Z',
      {from:{emailAddress:{address:'notpayroll@example.test'}}}) ]
  const res = await searchOutlook(lease, {sender:'payroll@example.test',from:'2026-11-01',to:'2026-11-01',timeZone:'America/New_York',order:'latest'},
    {fetch: async u => {
      assert.equal(u.pathname,'/v1.0/me/messages')
      assert.match(u.searchParams.get('$filter'),/^receivedDateTime ge .* and receivedDateTime lt .* and from\/emailAddress\/address eq 'payroll@example.test'$/)
      assert.equal(u.searchParams.get('$orderby'),'receivedDateTime desc')
      return Response.json({value:items})
    }})
  assert.deepEqual(res.items.map(m => m.id),['today'])
})
test('continuation is origin-bound; reading requests plain text and never changes message read state', async () => {
  let calls = 0
  await assert.rejects(searchOutlook(lease,{query:'payroll'},{fetch:async () => {
    ++calls
    return Response.json({value:[], '@odata.nextLink':'https://example.test/v1.0/me/messages?$skip=2'})
  }}),{code:'invalid_graph_page'})
  assert.equal(calls,1)
  const row = hit('match','Invoice','2026-11-20T00:00:00Z',{body:{contentType:'text',content:'Invoice 1234'},isRead:false})
  const read = await readOutlook(lease,'match',{fetch:async (u,init) => {
    assert.equal(u.pathname,'/v1.0/me/messages/match')
    assert.equal(init.method || 'GET','GET')
    assert.match(init.headers.prefer,/text/)
    return Response.json(row)
  }})
  assert.equal(read.text,'Invoice 1234')
  assert.ok(!('isRead' in read))
})

test('a revoked grant stops pagination and throttling retries before another provider call', async () => {
  for (const first of [
    () => Response.json({value: [], '@odata.nextLink':'/v1.0/me/messages?$skip=1'}),
    () => new Response(null, {status: 429, headers: {'retry-after':'0'}}),
  ]) {
    let allowed = true, calls = 0
    const checkedLease = {...lease, async check() { if (!allowed) throw Error('grant revoked') }}
    await assert.rejects(searchOutlook(checkedLease, {query:'invoice'}, {fetch: async () => {
      calls++
      allowed = false
      return first()
    }}), /grant revoked/)
    assert.equal(calls, 1)
  }
})

test('an exact identifier outranks a more recent prefix when the query also includes a topic', async () => {
  const exact = hit('body-id', 'Invoice attached', '2025-01-01T00:00:00Z', {bodyPreview:'Invoice for WC-103.'})
  const similar = hit('prefix', 'WC-1034 invoice', '2026-01-01T00:00:00Z')
  const result = await searchOutlook(lease, {query:'WC-103 invoice'}, {fetch: async () => Response.json({value:[similar, exact]})})
  assert.deepEqual(result.items.map(m => m.id), ['body-id', 'prefix'])
})

test('an unread Inbox search keeps its folder through pagination and validates returned read state', async () => {
  const path = '/v1.0/me/mailFolders/inbox/messages'
  const calls = []
  const result = await searchOutlook(lease, { folder:'inbox', unreadOnly:true }, { fetch: async url => {
    calls.push(url.pathname)
    const row = hit('inbox-unread', 'Update', '2026-11-23T12:00:00Z', {isRead:false})
    if (calls.length === 1) {
      assert.match(url.searchParams.get('$filter'), /receivedDateTime ge .+ and isRead eq false/)
      return Response.json({value:[{...row, id:'read', isRead:true}], '@odata.nextLink': path + '?$skip=1'})
    }
    return Response.json({value:[row]})
  } })
  assert.deepEqual(calls,[path,path])
  assert.deepEqual(result.items.map(row => row.id), ['inbox-unread'])
  await assert.rejects(searchOutlook(lease, {folder:'inbox'}, {
    fetch: async () => Response.json({value:[], '@odata.nextLink':'/v1.0/me/messages?$skip=2'})
  }), {code:'invalid_graph_page'})
})
