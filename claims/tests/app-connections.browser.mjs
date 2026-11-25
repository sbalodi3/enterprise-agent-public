// With no flags, check hosted and workstation Chat through the employee gateway.
// --emulator exercises Maya’s real local mailbox. --cms runs two live-model
// scenarios. --cms-all checks every CMS identity and keeps demo grants connected.
import { managedChatPorts } from '../desktop-chat/modes.mjs'
import { CMS_USERS } from '../auth/roster.mjs'
import { pickEmployee } from '../auth/tests/picker.mjs'
import { validateSnapshot } from '../showcase/cms-mcp/snapshot.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')
const shared = process.argv.includes('--shared')
const cmsAll = process.argv.includes('--cms-all')
const cms = cmsAll || process.argv.includes('--cms')
const app = new URL(process.env.CLAIMS_APP_ORIGIN || (cms ? 'http://127.0.0.1:3180' : 'http://localhost:3080'))
assert.ok(app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname))
const emulator = cms || process.argv.includes('--emulator')
const cmsExamples = [
  { id: 'cms-adjuster-01', claim: 'CLM-000020', receipt: 'AK-020-REVIEW' },
  { id: 'cms-adjuster-02', claim: 'CLM-000017', receipt: 'BL-017-REVIEW' },
]
async function cmsRoster() {
  const path = process.env.CLAIMS_CMS_TEST_SNAPSHOT ||
    new URL('../../.artifacts/claims-showcase/cms-mcp/snapshot.json', import.meta.url)
  const { rows } = validateSnapshot(JSON.parse(await readFile(path, 'utf8')))
  return CMS_USERS.filter(user => user.sourceAdjusterId).map(user => {
    const claims = rows.filter(row => row.sourceAdjusterId === user.sourceAdjusterId)
      .map(row => row.externalClaimNumber).sort()
    assert.equal(claims.length, 10)
    return { id: user.principalId, claims, claim: claims[0] }
  })
}
const cmsEmployees = cmsAll ? await cmsRoster() : cmsExamples
const first = cms && process.env.CLAIMS_CMS_TEST_FIRST
const start = first ? cmsEmployees.findIndex(employee => employee.id === first) : 0
assert.ok(start >= 0, 'CLAIMS_CMS_TEST_FIRST must be an adjuster included by the selected CMS test')
const runs = cms ? cmsEmployees.slice(start).map(employee => ({ employee, hosted: true }))
  : (emulator ? [true] : [true, false]).map(hosted => ({ employee: { id: 'maya' }, hosted }))
const chatPorts = managedChatPorts(Number(process.env.CLAIMS_CHAT_PORT_BASE || (cms ? 3183 : 3083)), cms)
const mailboxAccounts = new Set()
let rejectedConsents = 0

async function mailAnswer(page, trigger) {
  const [response] = await Promise.all([
    page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname.startsWith('/claims/api/mail-chat/'), { timeout: 150000 }),
    trigger(),
  ])
  const data = await response.json()
  assert.equal(response.status(), 200, data.code)
  return data.turn.answer
}

async function checkCmsMailbox(page, editor, employee) {
  const other = cmsEmployees.find(person => person.id !== employee.id)
  const transcript = page.getByRole('region', { name: 'Outlook conversation history' })
  const ask = text => mailAnswer(page, async () => { await editor.fill(text); await editor.press('Enter') })
  const search = await ask('Find my Outlook emails about ' + employee.claim)
  assert.equal(search.kind, 'search')
  const subject = employee.claim + ' correspondence'
  assert.deepEqual(search.items.map(item => item.subject).sort(), [subject, employee.claim + ' review update'])
  const ref = search.items.find(item => item.subject === subject).ref
  const read = await mailAnswer(page, () => transcript.getByRole('button', { name: subject, exact: true }).last().click())
  assert.equal(read.kind, 'read')
  assert.equal(read.items[0].ref, ref)
  assert.ok(read.text.includes(employee.receipt))
  assert.ok(!read.text.includes(other.receipt))
  await transcript.locator('article').last().getByText(read.text, { exact: true }).waitFor()
  const empty = await ask('Search my inbox for ' + other.claim)
  assert.equal(empty.kind, 'search')
  assert.deepEqual(empty.items, [])
  await transcript.locator('article').last().getByText(empty.text, { exact: true }).waitFor()

  let mailPosts = 0
  const countMail = req => { if (req.method() === 'POST' && new URL(req.url()).pathname.startsWith('/claims/api/mail-chat/')) mailPosts++ }
  page.on('request', countMail)
  try {
    const question = 'What is the status of claim ' + employee.claim + '?'
    const [response] = await Promise.all([
      page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === '/claims/api/chat/route'),
      (async () => { await editor.fill(question); await editor.press('Enter') })(),
    ])
    const route = await response.json()
    assert.equal(response.status(), 200, route.code)
    assert.equal(route.action, 'claims')
    assert.ok(route.scope.claimIds.includes(employee.claim))
    const turn = page.locator('.cs-transcript:visible article[data-turn-state=completed]').filter({ hasText: question }).last()
    await turn.waitFor({ timeout: 170000 })
    assert.equal(mailPosts, 0)
  } finally { page.off('request', countMail) }
  console.log('PASS', employee.id, 'own mailbox search and read, other claim absent, completed claims-only turn, connected grant retained')
}

async function checkCmsEnrollment(page, employee, peer) {
  const path = '/claims/api/connections'
  async function connection() {
    const own = await page.request.get(new URL(path, app).href)
    assert.equal(own.status(), 200)
    const { apps, csrfToken } = await own.json()
    return { mail: apps.find(app => app.id === 'outlook-mail'), csrfToken }
  }
  async function consent(address, csrfToken) {
    const begin = await page.request.post(new URL(path + '/outlook-mail/connect', app).href, {
      data: {}, headers: { origin: app.origin, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfToken },
    })
    assert.equal(begin.status(), 200)
    const target = new URL((await begin.json()).url)
    assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))
    const picker = await page.context().newPage()
    try {
      await picker.goto(target.href, { waitUntil: 'commit' })
      const callback = picker.waitForResponse(response => {
        const url = new URL(response.url())
        return url.origin === app.origin && url.pathname === '/claims/connections/microsoft/callback'
      })
      await picker.getByRole('button').filter({ hasText: address }).click({ noWaitAfter: true })
      return (await callback).status()
    } finally { await picker.close() }
  }
  const principal = await page.request.get(new URL('/auth/me', app).href)
  assert.equal(principal.status(), 200)
  assert.equal((await principal.json()).user.principalId, employee.id)
  const address = employee.id + '@example.test'
  const initial = await connection()
  assert.equal(initial.mail.mode, 'local')
  if (shared) assert.equal(initial.mail.status,'connected','Expected the existing grant to survive migration for '+employee.id)
  if (initial.mail.status !== 'connected') {
    assert.equal(await consent(peer.id + '@example.test', initial.csrfToken), 403)
    rejectedConsents++
    const denied = await connection()
    assert.ok(['off', 'reconnect'].includes(denied.mail.status))
    assert.equal(await consent(address, denied.csrfToken), 200)
  }
  const { mail } = await connection()
  assert.equal(mail.status, 'connected')
  assert.equal(mail.address, address)
  assert.ok(mail.accountId && !mailboxAccounts.has(mail.accountId), 'Expected a distinct mailbox for ' + employee.id)
  mailboxAccounts.add(mail.accountId)
  const ownChat = new URL(app)
  if (shared) {
    const forbidden = await page.request.get(new URL('/claims/api/items/' + peer.claim,app).href)
    assert.equal(forbidden.status(),404)
  } else {
    const peerOrigin = new URL(app)
    peerOrigin.port = chatPorts[peer.id]
    const rejected = await page.request.get(new URL(path, peerOrigin).href, { maxRedirects: 0 })
    assert.equal(rejected.status(), 403, 'Expected hosted Outlook denial for peer ' + peer.id)
    ownChat.port = chatPorts[employee.id]
  }
  const chatRows = await page.request.get(new URL('/claims/api/chat/search?status=all&assignedOnly=true', ownChat).href)
  assert.equal(chatRows.status(), 200)
  assert.deepEqual((await chatRows.json()).items.map(item => item.id).sort(), employee.claims)
  const peerClaim = await page.request.get(new URL('/claims/api/chat/search?status=all&q=' + peer.claim, ownChat).href)
  assert.equal(peerClaim.status(), 200)
  assert.equal((await peerClaim.json()).total, 0)
  const search = page.getByRole('searchbox', { name: 'Claim number or keywords' })
  await search.waitFor()
  const rows = page.locator('.cw-list .cw-row[data-item^=CLM]')
  await rows.filter({ hasText: employee.claim }).waitFor()
  assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.dataset.item).sort()), employee.claims)
  await search.fill(employee.claim.toLowerCase())
  const matching = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/claims/api/portfolio' && url.searchParams.get('q') === employee.claim.toLowerCase()
  })
  await search.press('Enter')
  assert.equal((await matching).status(), 200)
  await page.getByRole('button', { name: new RegExp('^Open ' + employee.claim + '\\b') }).click()
  await page.locator('.cw-detail > .cw-id').filter({ hasText: employee.claim }).waitFor()
  console.log('PASS', employee.id, employee.claim, 'own Outlook account, peer access denied, exact Chat and Workbench assignments')
}

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const { employee, hosted } of runs) {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: hosted ? { width: 1280, height: 800 } : { width: 536, height: 680 } })
    try {
      let status = 'off', startCount = 0
      const page = await context.newPage()
      page.setDefaultTimeout(25000)
      for (const [name, action] of [['Preview Notice', 'Continue'], ['Add an API key to get started', 'Configure later']]) {
        const dialog = page.getByRole('dialog', { name })
        await page.addLocatorHandler(dialog, () => dialog.getByRole('button',{name:action,exact:true}).click())
      }
      if (cmsAll) {
        await page.goto(new URL('/open-workbench', app).href, { waitUntil: 'commit' })
        await page.getByRole('list', { name: 'Pick an account' }).getByRole('button')
          .filter({ hasText: employee.id + '@example.test' }).click({ noWaitAfter: true })
        await page.waitForURL(url => url.origin === app.origin && url.pathname === '/' &&
          url.searchParams.get('mode') === 'workbench', { waitUntil: 'commit', timeout: 60000 })
        await checkCmsEnrollment(page, employee, cmsEmployees[(cmsEmployees.indexOf(employee) + 1) % cmsEmployees.length])
        continue
      }
      const button = (root, name) => root.getByRole('button', { name, exact: true })
      async function navigate(name) {
        const control = button(page, name)
        const closed = page.locator('[data-sidebar-collapsed=true] [data-sidebar-opener]:visible').first()
        if (await closed.count()) await closed.click()
        else if (!(await control.isVisible())) await page.locator('[data-sidebar-opener]:visible').first().click()
        await control.click()
      }
      if (hosted) await page.route('**/desktop/presence', route => route.abort())
      if (!emulator) await context.route('**/claims/api/connections', route => route.fulfill({ json: {
        csrfToken: 'fixture-csrf',
        apps: [{ id: 'outlook-mail', status, mode: 'local', available: true, address: status === 'connected' ? 'maya@example.test' : undefined }],
      } }))
      if (!emulator) await context.route('**/claims/api/connections/outlook-mail/*', route => {
        assert.equal(route.request().method(), 'POST')
        assert.equal(route.request().headers()['x-csrf-token'], 'fixture-csrf')
        if (route.request().url().endsWith('disconnect')) { status = 'off'; return route.fulfill({ json: {} }) }
        ++startCount
        return route.fulfill({ json: { url: new URL('/fixture-authorize', app).href } })
      })
      if (!emulator) await context.route('**/fixture-authorize', route => route.fulfill({ contentType: 'text/html', body: '<title>Synthetic sign-in</title>' }))
      await page.goto(new URL(shared && !hosted ? '/open-companion' : '/open-app', app).href)
      await pickEmployee(page, employee.id)
      const expectedPort = hosted ? (shared ? app.port : String(chatPorts[employee.id])) : String(Number(app.port) + 1)
      await page.waitForURL(url => url.port === expectedPort, { waitUntil: 'commit', timeout: 120000 })
      const editor = page.locator('[data-composer-card]:visible [contenteditable=true]').first()
      const composer = page.locator('[data-composer-card]:visible')
      await button(composer, 'Choose scope').waitFor({ timeout: 120000 })
      const attachment = 'outlook-round-trip.txt'
      if (!emulator) {
        await composer.locator('input[type=file]').setInputFiles({ name: attachment, mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') })
        await composer.getByText(attachment, { exact: true }).first().waitFor()
      }
      const draft = 'Unsent connection test draft'
      await editor.fill(draft)
      const editorNode = await editor.elementHandle()
      let documents = 0
      page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++ })
      await navigate('App connections')
      const toggle = page.getByRole('switch', { name: 'Allow agent access' })
      const modal = page.getByRole('dialog', { name: 'Connect your agent to Outlook?' })
      if (emulator) {
        await page.getByText('Local demo mailbox · synthetic messages').waitFor()
        if (!cms && await toggle.getAttribute('aria-checked') === 'true') {
          await toggle.click()
          await page.getByText('Off', { exact: true }).waitFor()
        }
      }
      if (!cms || await toggle.getAttribute('aria-checked') !== 'true') {
        await toggle.click()
        await button(modal, 'Cancel').click()
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'switch')
        assert.equal(await toggle.getAttribute('aria-checked'), 'false')
        assert.equal(startCount, 0)
        await toggle.click()
        const newPage = context.waitForEvent('page')
        await button(modal, 'Continue to demo sign-in').click()
        const popup = await newPage
        assert.equal(await toggle.getAttribute('aria-checked'), 'false')
        if (emulator) {
          await popup.getByRole('button').filter({ hasText: employee.id + '@example.test' }).click()
        } else {
          await popup.waitForURL('**/fixture-authorize')
          status = 'connected'
          await popup.close()
        }
      }
      await page.getByText(employee.id + '@example.test', { exact: true }).waitFor()
      assert.equal(await toggle.getAttribute('aria-checked'), 'true')
      await navigate('Return to chat')
      await editor.waitFor()
      await page.waitForFunction(() => !!document.activeElement?.closest('[data-composer-card] [contenteditable=true]'))
      assert.equal(await editor.innerText(), draft)
      if (!emulator) await composer.getByText(attachment, { exact: true }).first().waitFor()
      assert.ok(await editorNode.evaluate(el => el.isConnected))
      await page.goBack()
      await toggle.waitFor()
      await page.goForward()
      await editor.waitFor()
      assert.equal(documents, 0)
      if (cms) {
        await checkCmsMailbox(page, editor, employee)
        continue
      }
      if (emulator) {
        const transcript = page.getByRole('region', { name: 'Outlook conversation history' })
        const ask = text => mailAnswer(page, async () => { await editor.fill(text); await editor.press('Enter') })
        const matches = await ask('Search my Outlook email for Westfield')
        assert.equal(matches.kind, 'search')
        assert.equal(matches.items.length, 2)
        await transcript.getByText(matches.items[1].subject, { exact: true }).waitFor()
        const opened = await ask('Open the second one')
        assert.equal(opened.kind, 'read')
        assert.equal(opened.items[0].ref, matches.items[1].ref)
        assert.equal(opened.items[0].subject, matches.items[1].subject)
        console.log('PASS native composer searched the emulator and opened the same displayed second message')
      }
      await navigate('App connections')
      await toggle.click()
      await page.getByText('Off', { exact: true }).waitFor()
      assert.equal(await toggle.getAttribute('aria-checked'), 'false')
      await navigate('Return to chat')
      if (emulator) await page.getByRole('region', { name: 'Outlook conversation history' }).getByText('Open the second one', { exact: true }).waitFor()
      console.log('PASS ' + (hosted ? 'hosted' : 'workstation') + ' Outlook opt-in and disconnect preserve the native Chat document and draft')
    } catch (error) {
      throw new Error('App connections browser check failed for ' + employee.id, { cause: error })
    } finally { await context.close() }
  }
  if (cmsAll) {
    assert.equal(mailboxAccounts.size, runs.length)
    console.log('PASS', mailboxAccounts.size, 'distinct CMS mailboxes and', rejectedConsents,
      'rejected wrong-account consents for employees who needed to connect')
  }
} finally { await browser.close() }
