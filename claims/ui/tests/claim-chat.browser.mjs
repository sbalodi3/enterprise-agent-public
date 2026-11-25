// Keyless browser regression for the shared production drawer and hosted panel against authorized snapshots.
import { widgetResources } from '../../runtime/widget-resources.mjs'
import { startWidgetSandbox } from '../../runtime/widget-sandbox.mjs'
import { wageAnswer } from '../../runtime/wage-review.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { getDocument } from '../../showcase/data/documents.mjs'

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const context = await browser.newContext({ viewport: { width: 1380, height: 900 }, colorScheme: 'light' })
const page = await context.newPage()
const settings = { origin: 'http://127.0.0.1', parents: new Set(['http://localhost:8088']) }
const sandbox = await startWidgetSandbox(settings, 0, '127.0.0.1')
settings.origin += ':' + sandbox.address().port
let offline = false
page.setDefaultTimeout(12000)
if (process.env.CLAIMS_BROWSER_DIAGNOSTICS) {
  page.on('console', message => console.error(message.type(), message.text()))
  page.on('requestfailed', req => console.error('request failed', req.url(), req.failure()?.errorText))
  page.on('response', res => { if (res.url().includes('/proxy?')) console.error('proxy response', res.status(), res.url()) })
}
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const id = 'eb6bf4d8-43e5-4703-b65a-9378b08bc546'
const docs = [getDocument('WC-103-report'), getDocument('WC-103-shift')]
const sources = docs.map((doc, i) => ({
  claimId: 'WC-103', claimVersion: 1, documentId: doc.id, documentVersion: 1, title: doc.title, anchorId: i ? 'date' : 'account',
}))
const scope = { kind: 'claim', claimIds: ['WC-103'] }
const turns = [{ id: 'first', state: 'completed', question: 'Why are there two incident dates?',
  answer: { text: 'The report records November 9. The handover records November 10.', sources, why: 'The account in each source cites a different date.' },
  activity: [{ id: '1', label: 'Read WC-103 · Shift handover note', state: 'completed', tool: 'read_evidence' }] }]
const multiId = '0b6951f1-573f-49ab-b696-7ec3af47d2e1'
let multi
const conversation = () => ({ id, scope, turns })
const posts = []
let filteredCases, holdCaseSearch
let stale = false, sourceRevoked = false, historyDenied = 0
let holdHistory, holdSource
function barrier() {
  const reached = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers()
  return { reached, release, done }
}
const leaked = []
const name = (n) => page.getByRole('button', { name: n, exact: true })
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url()), path = url.pathname
  if (url.origin === settings.origin && path === '/proxy') {
    if (offline) return route.abort()
    // The harness parent page is intercepted. Supply the real listener response to its child
    // through the same fixture transport, preserving the browser origin and response policy.
    const response = await fetch(url)
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  }
  if (path === '/claims/assets/widget-settings.json') return route.fulfill({ json: { origin: settings.origin } })
  if (path.endsWith('.widget.json')) return route.fulfill({ json: widgetResources.get(path.split('/').at(-1).split('.')[0]) })
  if (path.endsWith('wage-review.bundle.mjs')) return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../build/wage-review.bundle.mjs', import.meta.url))})
  if (url.hostname !== 'localhost') { leaked.push(url.hostname); return route.abort() }
  const asset = async (file, type) => route.fulfill({ contentType: type, body: await readFile(file) })
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html style="color-scheme:light dark"><head><link rel="stylesheet" href="/claims/assets/claim-chat.css"><style>html,body,#app{height:100%;margin:0}body{font:14px system-ui}</style></head><body><div id="app"></div><script src="/react"></script><script src="/dom"></script><script type="module">
    import {createClaimChat} from '/claims/assets/claim-chat.mjs';
    const root=ReactDOM.createRoot(document.getElementById('app')), Chat=createClaimChat(React), target={id:'${id}'};
    function Demo(){const [visible,V]=React.useState(true);return React.createElement(React.Fragment,null,
      !visible && React.createElement('button',{onClick:()=>V(true)},'Ask agent'),
      React.createElement('div',{hidden:!visible,style:{height:'100%'}},React.createElement(Chat,{target,visible,full:location.search==='?full',onOpenCase:record=>{document.body.dataset.opened=record},onCollapse:()=>V(false)})))}
    root.render(React.createElement(Demo))
    </script></body></html>` })
  if (path === '/react' || path === '/dom') {
    const pkg = path === '/react' ? 'react' : 'react-dom'
    return asset(join(dirname(require.resolve(pkg)), 'umd', pkg + '.production.min.js'), 'text/javascript')
  }
  if (/^\/claims\/assets\/(action-review\.mjs|pdf-link\.mjs|claim-chat\.mjs|claim-scope\.mjs|claim-chat\.css|timeline-host\.mjs|widget-format\.mjs)$/.test(path))
    return asset(new URL('../' + path.split('/').at(-1), import.meta.url), path.endsWith('.css') ? 'text/css' : 'text/javascript')
  const json = (data, status = 200) => route.fulfill({ status, json: data })
  if (path.endsWith('/bootstrap')) return json({ enabled: true, csrfToken: 'fixture' })
  if (path.endsWith('/adjusters')) return json({ items: [], canFilterByOwner: false })
  if (path.endsWith('/search') && url.searchParams.get('offset') === '12') {
    assert.deepEqual(url.searchParams.getAll('lob'), ['AUTO', 'COMM_AUTO'])
    assert.equal(url.searchParams.get('assignedOnly'), 'true')
    assert.equal(url.searchParams.get('status'), 'open')
    assert.equal(url.searchParams.get('q'), '')
    return json({ items: filteredCases, total: 13 })
  }
  if (path.endsWith('/search') && url.searchParams.get('q') === 'CMS scope test') {
    const held = holdCaseSearch
    if (held) { holdCaseSearch = null; held.reached.resolve(); await held.release.promise }
    await json({ items: filteredCases, total: filteredCases.length })
    held?.done.resolve()
    return
  }
  if (path.endsWith('/search')) return json({ items: [{ id: 'WC-104', title: 'Diary review' }] })
  if (path.endsWith('/conversations') && route.request().method() === 'POST') {
    const requested = route.request().postDataJSON().scope
    assert.deepEqual(requested, { kind: 'multi', claimIds: ['WC-103', 'WC-104'] })
    multi = { id: multiId, scope: requested, turns: [] }
    return json(multi)
  }
  if (path.includes('/conversation/')) {
    if (historyDenied) return json({}, historyDenied)
    if (path.endsWith('/' + multiId)) return json(multi)
    const response = stale ? { id, scope, turns: [{ id: 'first', state: 'unavailable' }] } : structuredClone(conversation())
    const held = holdHistory
    if (held) { holdHistory = null; held.reached.resolve(); await held.release.promise }
    await json(response)
    held?.done.resolve()
    return
  }
  if (path.includes('/source/')) {
    const doc = docs.find((d) => d.id === url.searchParams.get('documentId'))
    assert.ok(doc)
    assert.equal(url.searchParams.get('claimVersion'), '1')
    assert.equal(url.searchParams.get('documentVersion'), '1')
    const held = holdSource, previous = sourceRevoked
    if (held) { holdSource = null; held.reached.resolve(); await held.release.promise }
    await json(previous ? {} : doc, previous ? 409 : 200)
    held?.done.resolve()
    return
  }
  if (path.includes('/turn/')) {
    assert.equal(route.request().headers()['x-csrf-token'], 'fixture')
    posts.push(route.request().postDataJSON())
    if (path.endsWith('/' + multiId)) {
      multi.turns.push({ id: 'multi-turn', requestId: posts.at(-1).requestId, state: 'completed', question: posts.at(-1).question,
        answer: { text: 'Compared both selected claims.', sources: [] }, activity: [] })
      return json({ conversationId: multiId, turnId: 'multi-turn' })
    }
    const timeline = { itemId: 'WC-103', version: 1, events: [], sources: docs.map((doc, i) => ({ id: doc.id, at: doc.asOf, title: doc.title, anchorId: sources[i].anchorId })) }
    turns.push({ id: 'second', state: 'completed', question: posts.at(-1).question, activity: [], answer: { text: 'Recorded history', timeline, sources } })
    return json({ conversationId: id, turnId: 'second' })
  }
  if (path.includes('/events/')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: conversation\ndata: ' + JSON.stringify(path.endsWith('/' + multiId) ? multi : conversation()) + '\n\n' })
  throw Error('Unexpected browser request ' + path)
})
try {
  await page.goto('http://localhost:8088')
  const composer = page.getByRole('textbox', { name: 'Message the claims agent' })
  await composer.fill('Show me the timeline')
  await name('Collapse').click()
  await name('Ask agent').click()
  assert.equal(await composer.inputValue(), 'Show me the timeline')
  await page.getByText('Activity', { exact: false }).first().click()
  await page.getByText('Read WC-103 · Shift handover note').waitFor()
  await name('Supervisor incident report').click()
  const reader = page.getByRole('region', { name: 'Source document' })
  assert.match(await reader.locator('.cc-cited').innerText(), /November 9/)
  await reader.getByRole('button', { name: 'Shift handover note' }).click()
  await reader.locator('.cc-cited').waitFor()
  assert.match(await reader.locator('.cc-cited').innerText(), /November 10/)
  assert.match(await reader.getByRole('link', { name: 'Open PDF' }).getAttribute('href'), /anchorId=date.*format=pdf#nameddest=date/)
  await name('Back to conversation').click()
  await name('Send').click()
  await page.frameLocator('iframe').frameLocator('iframe[title="Widget content"]').getByRole('button', { name: 'Open document · Shift handover note' }).waitFor()
  assert.equal(posts.length, 1)
  // Focus rechecks access. A new snapshot with the same timeline must preserve the interactive frame.
  const initialFrame = await page.locator('.cc-timeline iframe').elementHandle()
  assert.equal(new URL(await initialFrame.getAttribute('src')).origin, settings.origin)
  const proxy = await initialFrame.contentFrame()
  assert.equal(await proxy.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
  assert.equal(await proxy.childFrames()[0].evaluate(() => self.origin), 'null')
  turns.at(-1).answer.why = 'History rechecked while inspecting this timeline.'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByText(turns.at(-1).answer.why, { exact: true }).waitFor({ state: 'attached' })
  assert.equal(await initialFrame.evaluate(frame => frame.isConnected), true, 'An unchanged timeline must keep its frame')
  turns.at(-1).answer.timeline.events.push({ at: '2026-11-17T15:00:00Z', title: 'Shift review updated' })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(old => !old.isConnected, initialFrame)
  await page.frameLocator('iframe').frameLocator('iframe[title="Widget content"]').getByText('Shift review updated', { exact: true }).waitFor()
  await initialFrame.dispose()
  await page.frameLocator('iframe').frameLocator('iframe[title="Widget content"]').getByRole('button', { name: 'Open document · Shift handover note' }).click()
  await reader.locator('.cc-cited').waitFor()
  assert.match(await reader.locator('.cc-cited').innerText(), /November 10/)
  await name('Back to conversation').click()
  await page.setViewportSize({ width: 560, height: 780 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await name('Supervisor incident report').first().click()
  await reader.locator('.cc-cited').waitFor()
  assert.equal(await page.locator('.cc-conversation').isVisible(), false)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const flush = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  // An older successful read may finish after the server has already revoked a document.
  const firstSource = holdSource = barrier()
  await focus(); await firstSource.reached.promise
  sourceRevoked = true
  await focus()
  await reader.getByRole('alert').waitFor()
  firstSource.release.resolve(); await firstSource.done.promise; await flush()
  assert.equal(await reader.locator('.cc-cited').count(), 0)
  const firstHistory = holdHistory = barrier()
  await focus(); await firstHistory.reached.promise
  stale = true
  await focus()
  await page.getByText('An earlier turn is no longer available.').waitFor()
  firstHistory.release.resolve(); await firstHistory.done.promise; await flush()
  assert.equal(await page.locator('.cc-source-button').count(), 0)
  assert.equal(await reader.count(), 0)
  stale = false
  filteredCases = [{ id: 'CLM-000020', title: 'CMS scope test', nextAction: 'Review extract' }]
  turns.push({ id: 'cases', state: 'completed', question: 'What are my open auto cases?', answer: { text: 'Assigned cases', cases:
    { view: 'search', filters: { status: 'open', assignedOnly: true, lobs: ['AUTO', 'COMM_AUTO'] },
      items: Array.from({length: 12}, (_, i) => ({ id: 'CLM-' + String(i + 1).padStart(6,'0'), title: 'Auto claim', nextAction: 'Review' })), total: 13 } } })
  await focus()
  await page.getByLabel('Case list business line').waitFor()
  assert.equal(await page.getByLabel('Case list business line').inputValue(), 'AUTO,COMM_AUTO')
  await page.getByRole('searchbox', { name: 'Search case list' }).fill('CMS scope test')
  await name('Next cases').click()
  await page.getByText('13–13 of 13').waitFor()
  await name('Search cases').click()
  const cases = page.frameLocator('iframe[title="Interactive case list"]').frameLocator('iframe[title="Widget content"]')
  await cases.getByRole('button', { name: /^Open CLM-000020/ }).waitFor()
  assert.equal(await cases.locator('.case-copy strong').innerText(), 'Review extract', 'An older action-only row remains readable')
  sourceRevoked = false
  const review = wageAnswer({ sources, facts: [{ id:'fact_1', component:'Gap', text:'A payroll period needs review.', refs:[0] }] }, null)
  turns.push({id:'wage', state:'completed', question:'Review missing payroll', answer:review})
  await focus()
  const rendered = page.locator('a2ui-surface')
  await rendered.getByRole('button', {name:'Supervisor incident report · account'}).focus()
  await page.keyboard.press('Enter')
  await reader.getByText(/November 9/).first().waitFor()
  await name('Back to conversation').click()
  const pendingSearch = holdCaseSearch = barrier()
  filteredCases = []
  await page.evaluate(() => window.dispatchEvent(new Event('claims:portfolio-refreshed')))
  await pendingSearch.reached.promise
  await page.locator('iframe[title="Interactive case list"]').waitFor({ state: 'detached' })
  pendingSearch.release.resolve()
  await pendingSearch.done.promise
  await cases.getByText('No cases match this view.').waitFor()
  assert.equal(await cases.getByRole('button').count(), 0)
  await page.setViewportSize({ width: 320, height: 780 })
  const longTitle = 'Commercial wind damage with supplementary documentation '.repeat(5).trim()
  const groups = [{ key: 'COMM_AUTO', label: 'COMM_AUTO', count: 12, billingsAmount: '0.00', litigatedCount: 0,
    items: Array.from({length:12}, (_, i) => ({ id: 'CLM-' + i, title: longTitle })) }]
  const hiddenFrame = await page.addStyleTag({ content: '.cc-summary-app { display: none; }' })
  turns.push({ id:'layout', state:'completed', question:'Show the portfolio', answer:{ text:'Summary', summary:{ total:12, groupBy:'lob', groups } } })
  await focus()
  const outer = page.locator('iframe[title="Interactive portfolio summary"]')
  const app = page.frameLocator('iframe[title="Interactive portfolio summary"]').frameLocator('iframe[title="Widget content"]')
  const group = app.getByLabel('Commercial auto · 12 claims')
  await app.locator('.group').waitFor({ state: 'attached' })
  await page.waitForFunction(() => document.querySelector('.cc-summary-app')?.style.height)
  await hiddenFrame.evaluate(style => style.remove())
  await group.waitFor()
  // Missing top-level metrics stay absent even when group-level metrics are zero.
  assert.deepEqual(await app.locator('#metrics dd').allTextContents(), ['12'])
  await page.waitForFunction(() => Number.parseInt(document.querySelector('.cc-summary-app')?.style.height) > 60)
  const collapsed = (await outer.boundingBox()).height
  await group.press('Enter')
  await app.getByText('Billings 0.00 · Litigated claims 0').waitFor()
  await page.waitForFunction(() => document.querySelector('.cc-summary-app')?.offsetHeight === 440)
  assert.ok(await app.locator('html').evaluate(root => root.scrollWidth <= root.clientWidth))
  await page.evaluate(() => { document.documentElement.style.colorScheme = 'light' })
  await app.locator('html[style*="light"]').waitFor({state:'attached'})
  await page.evaluate(() => { document.documentElement.style.colorScheme = 'dark' })
  await app.locator('html[style*="dark"]').waitFor({state:'attached'})
  assert.ok(await app.locator('details').evaluate(el => el.open), 'Theme changes preserve expansion')
  await group.press('Enter')
  await page.waitForFunction(height => document.querySelector('.cc-summary-app')?.offsetHeight === height, collapsed)
  turns.pop()
  await page.setViewportSize({ width: 560, height: 780 })
  // The authorized transcript and claim buttons remain usable during a proxy outage.
  offline = true
  const summary = { total: 1, groups: [{ key: 'auto', label: 'Automobile', count: 1, billingsAmount: '100', litigatedCount: 0,
    items: [{id:'WC-103', title:'Conflicting incident dates'}] }] }
  turns.push({ id: 'offline', state: 'completed', question: 'Group by business line', answer: { text:'One case', summary } })
  await focus()
  const fallback = page.locator('details[open]').filter({has:page.getByText('Portfolio summary as text', {exact:true})})
  await fallback.getByText('Automobile · 1').click()
  await fallback.getByRole('button', {name:/WC-103/}).click()
  assert.equal(await page.locator('body').getAttribute('data-opened'), 'WC-103')
  offline = false
  turns.pop()
  turns.pop()
  turns.push({ id: 'suggest', state: 'completed', question: 'Compare the next steps across the selected claims.',
    answer: { text: 'Choose the claims to compare.', suggestedClaims: [{ id: 'WC-103', title: 'Conflicting incident dates' }] } })
  await focus()
  await name('Add claim').click()
  await page.getByRole('searchbox', { name: 'Find a claim' }).fill('WC-104')
  await name('WC-104 · Diary review').click()
  assert.equal(posts.length, 1, 'Editing a suggested set cannot run a turn')
  await name('Compare selected').click()
  await page.getByText('Compared both selected claims.').waitFor()
  assert.equal(posts.length, 2)
  assert.equal(posts[1].question, 'Compare the next steps across the selected claims.')
  historyDenied = 401
  await focus()
  const login = page.getByRole('link', { name: 'Sign in to resume this conversation' })
  await login.waitFor()
  assert.equal(await login.getAttribute('href'), '/auth/hosted-chat?conversation=' + multiId)
  historyDenied = 404
  await focus()
  await login.waitFor({ state: 'hidden' })
  assert.deepEqual(leaked, [])
  assert.deepEqual(errors, [])
  console.log('PASS drawer draft, verified sources and PDF, timeline follow-up, narrow layout, reordered access checks and editable comparison sets')
} finally { sandbox.close(); sandbox.closeAllConnections(); await browser.close() }
