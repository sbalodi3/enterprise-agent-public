import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeClaims } from '../ui/native-claims.mjs'
import { selections, selectionScope } from '../ui/claim-scope.mjs'

test('the composer round-trips whole claims and individual documents', () => {
  const scope = { kind: 'multi', claimIds: ['WC-101', 'WC-103'], documents: { 'WC-103': ['WC-103-shift'] } }
  const entries = selections(scope)
  assert.equal(entries.get('WC-101'), null)
  assert.deepEqual(selectionScope(entries), scope)
  entries.delete('WC-103')
  assert.deepEqual(selectionScope(entries), { kind: 'claim', claimIds: ['WC-101'] })
  entries.clear()
  assert.deepEqual(selectionScope(entries), { kind: 'workspace' })
})

test('native admission creates a single protected thread, resumes it and holds unavailable routes', async t => {
  const session = 'workspace-session'
  const id = '1b0b8521-8e96-4190-b868-d42cccf7648e'
  const claims = { kind: 'claim', claimIds: ['WC-103'] }
  let scope = { kind: 'workspace' }, unavailable = false, clarify = false
  const record = { id, scopeRevision: 1, focus: null, turns: [] }
  const posts = []
  const storage = new Map()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v),
  } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else delete globalThis.sessionStorage })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = url.slice('/claims/api/chat/'.length)
    const body = init.body && JSON.parse(init.body)
    if (body) posts.push({ path, body, csrf: init.headers['X-CSRF-Token'] })
    if (path === 'route') {
      if (unavailable) return new Response(null, { status: 503 })
      if (clarify) return Response.json({ action: 'clarify', scope })
      return Response.json(body.question === 'workspace task' ? { action: 'workspace', scope } :
        { action: 'claims', scope: claims, reason: 'attached', added: [{ claimId: 'WC-103' }] })
    }
    if (path === 'conversations') { assert.equal(body.fresh, true); scope = body.scope; return Response.json({ ...record, scope }) }
    if (path === 'conversation/' + id) return Response.json({ ...record, scope })
    if (path === 'turn/' + id) { assert.equal(body.planned, true); assert.deepEqual(scope, {kind:'workspace'}); record.focus = claims; assert.equal(body.expectedRevision, 1); record.turns.push({ id: body.requestId, state: 'completed' }); return Response.json({ turnId: body.requestId }) }
    throw Error('Unexpected path ' + path)
  })
  const host = createNativeClaims({}, {}, 'csrf')
  assert.equal(await host.dispatch(session, 'workspace task', 0), 'workspace')
  assert.equal(await host.dispatch(session, 'show WC-103', 0), 'handled')
  assert.equal(host.hasThread(session), true)
  assert.equal(host.isScoped(session), true)
  const resumed = createNativeClaims({}, {}, 'csrf')
  assert.equal(resumed.isScoped(session), true)
  await resumed.bind(session, { conversation: id })
  assert.equal(await resumed.dispatch(session, 'timeline', 0), 'handled')
  unavailable = true
  assert.equal(await resumed.dispatch(session, 'read evidence', 0), 'hold')
  unavailable = false; clarify = true
  assert.equal(await resumed.dispatch(session, 'ambiguous reference', 0), 'hold')
  assert.equal(posts.filter(p => p.path === 'conversations').length, 1)
  assert.equal(posts.filter(p => p.path === 'turn/' + id).length, 2)
  assert.ok(posts.every(p => p.csrf === 'csrf'))
  assert.ok([...storage.values()].every(v => !/show WC-103|timeline|read evidence/.test(v)))
})

test('follow-ups use the most recent protected, workspace, or native Outlook result across reloads', async t => {
  const session = 'source-switch', id = crypto.randomUUID()
  const workspace = {kind:'workspace'}, outlook = {kind:'outlook'}
  const cohort = {kind:'portfolio',operation:'list',filters:{status:'open',lobs:['Personal Auto','Commercial Auto']}}
  const record = {id,scope:workspace,scopeRevision:1,turns:[]}, routes = [], admissions = [], mail = []
  const storage = new Map(), original = Object.getOwnPropertyDescriptor(globalThis,'sessionStorage')
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{
    getItem:k=>storage.get(k) ?? null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),
  }})
  t.after(()=>{ if (original) Object.defineProperty(globalThis,'sessionStorage',original); else delete globalThis.sessionStorage })
  const add = plan => {
    const turn = {id:crypto.randomUUID(),state:'completed',plan}
    record.turns.push(turn)
    return turn.id
  }
  const first = add(outlook)
  t.mock.method(globalThis,'fetch',async (url,init) => {
    const body = init.body && JSON.parse(init.body)
    if (url === '/claims/api/mail-chat/' + session) {
      if (!body) return Response.json({connected:true,turns:[],more:false})
      mail.push(body.question)
      return Response.json({turn:{id:body.requestId,question:body.question,answer:{kind:'search',items:[]}}})
    }
    if (url.endsWith('/conversation/' + id)) return Response.json(record)
    if (url.endsWith('/route')) {
      routes.push(body)
      const protectedQuery = ['list my claims','read the first one','how many?'].includes(body.question) &&
        (body.question === 'list my claims' || !!body.previous)
      return Response.json({action:protectedQuery ? 'claims' : 'workspace'})
    }
    if (url.endsWith('/turn/' + id)) {
      admissions.push(body)
      return Response.json({turnId:add(cohort)})
    }
    throw Error('Unexpected request ' + url)
  })
  async function resume() {
    const chat = createNativeClaims({}, {}, 'csrf')
    await chat.bind(session,{conversation:id})
    return chat
  }
  let chat = await resume()
  assert.equal(await chat.dispatch(session,'inspect README.md',0),'workspace')
  assert.deepEqual(routes.at(-1).previous,outlook)
  chat = await resume()
  assert.equal(await chat.dispatch(session,'read the first one',0),'workspace')
  assert.equal(routes.at(-1).previous,undefined)
  assert.deepEqual(mail,[])
  assert.equal(await chat.dispatch(session,'list my claims',0),'handled')
  assert.equal(admissions.at(-1).excludedPreviousTurnId,first)
  assert.equal(await chat.dispatch(session,'how many?',0),'handled')
  assert.deepEqual(routes.at(-1).previous,cohort)
  assert.equal(admissions.at(-1).excludedPreviousTurnId,undefined)
  const beforeMail = record.turns.at(-1).id
  assert.equal(await chat.dispatch(session,'show my latest email',0),'handled')
  chat = await resume()
  assert.equal(await chat.dispatch(session,'read the first one',0),'handled')
  assert.deepEqual(mail,['show my latest email','read the first one'])
  assert.equal(await chat.dispatch(session,'how many?',0),'workspace')
  assert.equal(routes.at(-1).previous,undefined)
  assert.equal(await chat.dispatch(session,'list my claims',0),'handled')
  assert.equal(admissions.at(-1).excludedPreviousTurnId,beforeMail)
  // A newer authorized drawer turn takes precedence over the native source marker.
  assert.equal(await chat.dispatch(session,'show my latest email',0),'handled')
  add(outlook)
  chat = await resume()
  assert.equal(await chat.dispatch(session,'read the first one',0),'handled')
  assert.deepEqual(routes.at(-1).previous,outlook)
  assert.equal(admissions.at(-1).excludedPreviousTurnId,undefined)
  assert.equal(mail.length,3)
})
