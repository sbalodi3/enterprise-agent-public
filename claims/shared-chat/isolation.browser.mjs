import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { pickEmployee } from '../auth/tests/picker.mjs'
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(process.env.CLAIMS_TEST_PLAYWRIGHT || 'playwright')
import { CMS_USERS } from '../auth/roster.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const origin = new URL(process.env.CLAIMS_TEST_ORIGIN)
assert.ok(['127.0.0.1','localhost'].includes(origin.hostname))
const users = process.env.CLAIMS_TEST_CMS === '1' ? ['cms-adjuster-01','cms-adjuster-02'] : ['maya','alex']
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome', headless: true })
async function signIn(user) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(process.env.CLAIMS_TEST_LIVE_MODEL ? 90000 : 20000)
  await page.goto(new URL('/chat',origin).href)
  await pickEmployee(page,user)
  await page.waitForURL(url => url.origin === origin.origin && url.pathname === '/chat')
  for (const [title, action] of [['Preview Notice','Continue'],['Add an API key to get started','Configure later']]) {
    const dialog = page.getByRole('dialog',{name:title})
    await page.addLocatorHandler(dialog, () => dialog.getByRole('button',{name:action,exact:true}).click())
  }
  const me = await page.evaluate(async () => (await fetch('/auth/me')).json())
  assert.equal(me.user.principalId, user)
  return page
}
async function rpc(page, method, args) {
  return page.evaluate(async ({ method, args }) => {
    const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method, rpcId: crypto.randomUUID(), payload: { args } }) })
    const reply = await response.json()
    return reply.result
  }, { method, args })
}
async function send(page, question, answer, approve = false) {
  const editor = page.locator('[data-composer-input][contenteditable=true]').first()
  await editor.fill(question)
  await editor.press('Enter')
  await page.getByText(question, {exact:true}).first().waitFor()
  if (approve) await page.getByRole('button',{name:'Allow once',exact:true}).click()
  if (answer) await page.getByText(answer, {exact:true}).last().waitFor()
  if (process.env.CLAIMS_TEST_LIVE_MODEL) {
    const id = await editor.evaluate(el => el.closest('[data-conversation-session]').dataset.conversationSession)
    const deadline = Date.now() + 120000
    for (;;) {
      const reply = await rpc(page,'session/events',{request:{address:{kind:'session',sessionId:id},maxMessages:16}})
      assert.ok(reply.ok, 'Owner must be able to read durable events')
      const events = reply.value.records.map(record => record.event ?? record)
      const index = events.findLastIndex(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes(question))
      if (index >= 0) {
        const subsequent = events.slice(index+1)
        const end = subsequent.find(event => event.type === 'turn/end')
        if (end) {
          assert.equal(end.data.reason.kind,'completed')
          assert.ok(subsequent.some(event => event.type === 'assistant/message'))
          break
        }
      }
      if (Date.now() >= deadline) throw Error('Timed out waiting for native assistant response to the submitted question')
      await page.waitForTimeout(500)
    }
  }
}
try {
  const pages = await Promise.all(users.map(signIn))
  console.log('Signed in both employees at '+origin.origin)
  const drafts = users.map(() => 'Reply with the word ready. Reference ' + randomUUID())
  for (const [index,page] of pages.entries()) {
    try {
      await send(page, drafts[index], process.env.CLAIMS_TEST_REPLY)
    } catch (error) {
      console.error('Chat surface at failure:', (await page.locator('body').innerText()).slice(0,1800))
      throw error
    }
  }
  for (const [index,page] of pages.entries()) {
    assert.equal(await page.getByText(drafts[1-index],{exact:true}).count(),0)
    assert.equal((await page.request.get(new URL('/chat',origin).href)).status(),200)
  }
  const providers = []
  for (const [i, page] of pages.entries()) {
    const catalog = await rpc(page, 'session/modelCatalog', {})
    assert.ok(catalog.ok, catalog.error?.message)
    const provider = catalog.value.default.provider
    providers.push(provider)
    assert.deepEqual(catalog.value.routableProviders, [provider])
    if (process.env.CLAIMS_TEST_PERSONAL_MODEL === '1') {
      const sessionId = await page.locator('[data-composer-input][contenteditable=true]').first()
        .evaluate(el => el.closest('[data-conversation-session]').dataset.conversationSession)
      const events = await rpc(page, 'session/events', {request: {address: {kind: 'session', sessionId}, maxMessages: 50}})
      assert.ok(events.ok)
      const context = events.value.records.map(row => row.event ?? row).findLast(event => event.type === 'request/context')
      assert.equal(context?.data.provider, provider)
      assert.equal(context.data.contextWindow, i === 0 ? 8192 : 32768)
    }
  }
  if (process.env.CLAIMS_TEST_PERSONAL_MODEL === '1') {
    assert.equal(providers[0], 'claims-local')
    assert.match(providers[1], /^claims-employee-/)
    console.log('Verified private model catalogs and the 8192 and 32768 token limits on actual turns.')
  }
  const lists = await Promise.all(pages.map(page => rpc(page,'session/list',{_request:{}})))
  const owned = lists.map(list => { assert.ok(list.ok); assert.ok(list.value.items.length); return list.value.items.map(row => row.sessionId) })
  assert.ok(owned[0].every(id => !owned[1].includes(id)))
  for (const [index,page] of pages.entries()) {
    const other = owned[1-index][0]
    const target = { request: { sessionId: other } }
    for (const [method,args] of [['session/state',target], ['session/rename',{request:{sessionId:other,title:'denied'}}]]) {
      const denied = await rpc(page,method,args)
      assert.equal(denied.error?.code, 'remote-access/denied')
    }
  }
  console.log('Verified private history and direct native access for both employees.')
  if (process.env.CLAIMS_TEST_INVENTORY) {
    const folder = process.env.CLAIMS_TEST_INVENTORY
    const index = JSON.parse(await readFile(join(folder, 'index.json')))
    for (const [i,page] of pages.entries()) {
      const record = index.records.find(record => record.principalId === users[i])
      const manifest = JSON.parse(await readFile(join(folder,record.manifest)))
      for (const id of manifest.sessionIds) assert.ok(owned[i].includes(id), 'Imported conversation missing from employee history')
      const largest = manifest.files.filter(file => /session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(file.path)).sort((a,b) => b.bytes-a.bytes)[0]
      const id = largest?.path.split('/').at(-2)
      if (id) assert.ok(manifest.sessionIds.includes(id))
      if (id) {
        const url = new URL('/chat?session='+id,origin).href
        assert.equal((await pages[1-i].request.get(url)).status(),404)
        await page.goto(url)
        const selected = page.locator('[data-conversation-session="'+id+'"] [data-composer-input][contenteditable=true]')
        try { await selected.waitFor({timeout:15000}) }
        catch (error) {
          console.error('Direct conversation', new URL(page.url()).pathname,
            await page.locator('[data-conversation-content]').evaluateAll(items=>items.map(el=>el.dataset.conversationSession)))
          throw error
        }
        await send(page, 'Reply with the single word ready. Use only this message. Reference '+randomUUID(), process.env.CLAIMS_TEST_REPLY)
        const state = await rpc(page,'session/state',{request:{sessionId:id}})
        assert.ok(state.ok)
      }
      const uploads = await (await page.request.get(new URL('/chat/uploads',origin).href)).json()
      const originals = new Map(manifest.files.filter(f => f.kind === 'file' && f.path.includes('/attachments/v1/files/')).map(f => [f.path.split('/').at(-1), f.sha256]))
      const verified = new Set()
      for (const item of uploads.filter(item=>originals.has(item.name))) {
        const url = new URL('/chat/uploads?id='+item.id,origin).href
        assert.equal((await pages[1-i].request.get(url)).status(),404)
        const response = await page.request.get(url)
        assert.equal(response.status(),200)
        const digest = createHash('sha256').update(await response.body()).digest('hex')
        assert.equal(originals.get(item.name),digest)
        verified.add(item.name)
      }
      assert.equal(verified.size,originals.size)
    }
  }
  if (process.env.CLAIMS_TEST_SETTINGS === '1') {
    const read = async page => {
      const result = await rpc(page,'settings/describe',{})
      assert.ok(result.ok)
      return result.value.namespaces.find(row => row.ns === 'ui-theme')
    }
    const [first,second] = await Promise.all(pages.map(read))
    const preference = first.value.preference === 'dark' ? 'light' : 'dark'
    const update = {ns:'ui-theme',patch:{preference},expectedRevision:first.revision}
    assert.ok((await rpc(pages[0],'settings/update',update)).ok)
    assert.equal((await read(pages[0])).value.preference,preference)
    const peer = await read(pages[1])
    assert.deepEqual(peer.user,second.user)
    assert.deepEqual(peer.value,second.value)
    assert.equal(peer.revision,second.revision)
    assert.equal((await rpc(pages[0],'settings/update',update)).error.code,'settings/conflict')
    assert.ok((await rpc(pages[0],'settings/replace',{ns:'ui-theme',section:first.user,expectedRevision:first.revision+1})).ok)
  }
  if (process.env.CLAIMS_TEST_ROSTER === '1') {
    for (const person of CMS_USERS.filter(person=>!users.includes(person.principalId))) {
      const page = await signIn(person.principalId)
      try {
        await send(page,'Reply with the single word ready. Use only this message. Reference '+randomUUID(), process.env.CLAIMS_TEST_REPLY)
        const list = await rpc(page,'session/list',{_request:{}})
        assert.ok(list.ok && list.value.items.length)
        assert.ok(list.value.items.every(item => !owned.flat().includes(item.sessionId)))
        console.log('Verified text Chat for '+person.principalId)
      } finally {await page.context().close()}
    }
    console.log('All 20 CMS adjusters and the administrator signed in and used text Chat.')
  }
  if (process.env.CLAIMS_TEST_COMMAND === '1') {
    const anotherTab = await pages[0].context().newPage()
    const created = await rpc(pages[0],'session/create',{request:{}})
    assert.ok(created.ok)
    const url = new URL('/chat?session='+created.value.sessionId,origin)
    await anotherTab.goto(url.href)
    const requests = [pages[0],anotherTab,pages[1]].map(page => ({page,proof:randomUUID()}))
    await Promise.all(requests.map(async ({page,proof}) => {
      await send(page,'Create a workspace smoke file '+proof,'Workspace tool result received.',true)
      const path = new URL('/chat/files?path=proof-'+proof+'.txt&read=1',origin).href
      const ownFile = await page.request.get(path)
      assert.equal(ownFile.status(),200)
      assert.equal(Buffer.from((await ownFile.json()).data,'base64').toString(),proof+'\n')
      const peer = page===pages[1] ? pages[0] : pages[1]
      assert.equal((await peer.request.get(path)).status(),409)
    }))
    console.log('Three concurrent approved tool calls from two employees returned private files to their conversations.')
  }
  const sockets = await Promise.all(pages.map(async (page,index) => {
    const probe = await page.context().newPage()
    await probe.goto(new URL('/health/ready',origin).href)
    await probe.evaluate(({own,other})=>new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>reject(Error('Timed out checking private event streams')),10000)
      const ws = new WebSocket(new URL('/api/remote.mux',location.href.replace(/^http/,'ws')))
      window.isolationSocket = ws
      let allowed=false, denied=false
      ws.onopen = () => {
        for (const [streamId,sessionId] of [['owner',own],['other',other]]) {
          ws.send(JSON.stringify({type:'open',streamId,endpoint:'session/observeEvent',
            payload:{args:{request:{address:{kind:'session',sessionId}}}}}))
        }
      }
      ws.onerror = () => reject(Error('Native event socket failed'))
      ws.onmessage = message => {
        const frame=JSON.parse(message.data)
        if (frame.streamId==='owner' && frame.type==='item' && frame.value.type==='ready') allowed=true
        if (frame.streamId==='other' && frame.type==='error' && frame.error.code==='remote-access/denied') denied=true
        if (frame.streamId==='other' && frame.type==='item') reject(Error('Cross-owner stream delivered an event'))
        if (allowed && denied) {clearTimeout(timer);resolve()}
      }
    }),{own:owned[index][0],other:owned[1-index][0]})
    return probe
  }))
  const me = await (await pages[0].request.get(new URL('/auth/me',origin).href)).json()
  const cookie = (await pages[0].context().cookies(origin.href)).map(item=>item.name+'='+item.value).join('; ')
  const stream = await fetch(new URL('/auth/session-watch',origin), {headers:{cookie},signal:AbortSignal.timeout(10000)})
  const closed = stream.text()
  await pages[0].evaluate(()=>localStorage.setItem('isolation-draft','private'))
  const logout = await pages[0].request.post(new URL('/auth/logout',origin).href, {headers:{origin:origin.origin,'x-csrf-token':me.csrfToken}})
  assert.equal(logout.status(),200)
  assert.ok(logout.headers()['clear-site-data'].includes('storage'))
  await closed
  await sockets[0].waitForFunction(()=>window.isolationSocket.readyState===WebSocket.CLOSED)
  assert.equal(await sockets[1].evaluate(()=>window.isolationSocket.readyState===WebSocket.OPEN),true)
  assert.equal((await pages[0].request.get(new URL('/auth/me',origin).href)).status(),401)
  assert.equal((await pages[1].request.get(new URL('/auth/me',origin).href)).status(),200)
  const switched = await pages[0].context().newPage()
  await switched.goto(new URL('/chat',origin).href)
  await pickEmployee(switched,users[1])
  await switched.waitForURL(url=>url.origin===origin.origin && url.pathname==='/chat')
  assert.equal(await switched.evaluate(()=>localStorage.getItem('isolation-draft')),null)
  const afterSwitch = await rpc(switched,'session/list',{_request:{}})
  assert.ok(afterSwitch.ok && afterSwitch.value.items.some(row=>owned[1].includes(row.sessionId)))
  assert.ok(afterSwitch.value.items.every(row=>!owned[0].includes(row.sessionId)))
  console.log('Two verified employees used separate conversations, and switching accounts cleared the previous browser state.')
} finally { await browser.close() }
