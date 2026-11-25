// Requires the running local synthetic Workbench, Entra Local directory and seeded claims database.
import { pickEmployee } from './picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { basename } from 'node:path'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const origin = new URL(process.env.CLAIMS_APP_ORIGIN || 'http://localhost:3080')
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'Acceptance test requires loopback')
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome', headless: true })
const desktop = process.env.CLAIMS_DESKTOP_ACCEPTANCE === '1'
const chatOrigin = 'http://localhost:3081'
const alexChatOrigin = 'http://localhost:3084'
const presence = chatOrigin + '/desktop/presence'
let step = 'starting'
const passed = message => console.log('PASS: ' + message)
async function login(username) {
  const context = await browser.newContext()
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  // Fresh employee chat profiles show the harness's first-run dialogs.
  for (const [title, action] of [
    ['Preview Notice', 'Continue'],
    ['Add an API key to get started', 'Configure later'],
  ]) {
    const dialog = page.getByRole('dialog', { name: title })
    await page.addLocatorHandler(dialog, () => dialog.getByRole('button', { name: action, exact: true }).click())
  }
  if (desktop && username === 'maya') {
    await page.route(chatOrigin + '/claims/api/chat/bootstrap', route => route.fulfill({ status: 503 }), { times: 1 })
  }
  await page.goto(desktop ? origin.href : new URL('/open-workbench', origin).href)
  await pickEmployee(page, username)
  if (desktop) {
    await page.waitForURL(url => url.origin === (username === 'maya' ? chatOrigin : alexChatOrigin))
    await page.getByRole('button', { name: 'Add workspace' }).waitFor()
  } else await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor()
  return { context, page }
}
async function request(page, path, body, headers = {}) {
  return page.evaluate(async ({ path, body, headers }) => {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, data: await response.json() }
  }, { path, body, headers })
}
try {
  if (desktop) {
    step = 'direct desktop navigation before sign-in'
    const anonymous = await browser.newContext()
    const unauthenticated = await anonymous.newPage()
    await unauthenticated.goto(chatOrigin)
    await unauthenticated.getByRole('list', { name: 'Pick an account' }).waitFor()
    assert.equal((await anonymous.request.get(chatOrigin + '/api', { maxRedirects: 0 })).status(), 401)
    assert.equal((await anonymous.request.get(alexChatOrigin + '/api', { maxRedirects: 0 })).status(), 401)
    await anonymous.close()
    passed('direct chat requires Entra Local and anonymous chat API requests are denied')
  }
  step = 'interactive Maya and Alex login'
  const maya = await login('maya'), alex = await login('alex')
  const me = desktop ? '/desktop/workbench/me' : '/auth/me'
  const mi = await request(maya.page, me), ai = await request(alex.page, me)
  assert.equal(mi.data.user.principalId, 'maya')
  assert.equal(ai.data.user.principalId, 'alex')
  assert.equal(mi.data.user.subject, '5e759d8b-0cab-460f-a32e-000000000001')
  assert.equal(ai.data.user.subject, '5e759d8b-0cab-460f-a32e-000000000002')
  assert.equal(mi.data.user.tenantId, 'demo')
  assert.notEqual(mi.data.csrfToken, ai.data.csrfToken)
  passed('real OIDC identities and profile-specific landing')

  let chatTab
  if (desktop) {
    step = 'recovering a failed scope picker request on the signed-in workstation'
    await maya.page.waitForURL(url => url.origin === chatOrigin, {waitUntil: 'commit'})
    await maya.page.getByRole('button', { name: 'Add workspace' }).waitFor()
    assert.equal(new URL(maya.page.url()).origin, chatOrigin)
    const composer = maya.page.locator('[data-composer-card]:visible')
    const recovery = composer.getByRole('button', { name: 'Retry', exact: true })
    await recovery.waitFor()
    assert.equal(await maya.page.getByRole('alert').filter({ hasText: 'The claims service is unavailable.' }).count(), 1)
    const draft = composer.locator('[contenteditable=true]').first()
    const question = 'Synthetic unsent draft for scope recovery'
    await draft.fill(question)
    await recovery.click()
    await composer.getByRole('button', { name: 'Choose scope', exact: true }).waitFor()
    assert.equal(await draft.innerText(), question)
    await draft.fill('')
    await maya.page.getByRole('button', { name: 'New session', exact: true }).last().waitFor()
    passed('Sign-in opens native Agent Chat and a failed bootstrap retries in place')
    step = 'opening a second authenticated desktop tab'
    chatTab = await maya.context.newPage()
    await chatTab.goto(chatOrigin)
    await chatTab.getByRole('button', { name: 'Add workspace' }).waitFor()
    step = 'returning from desktop chat to Workbench'
    await maya.page.getByRole('button', { name: 'Workbench', exact: true }).click()

    step = 'using a hosted workspace when the workstation companion is offline'
    const fallback = await maya.context.newPage()
    await fallback.route(presence, route => route.abort('connectionrefused'))
    await fallback.goto(origin.href)
    await fallback.waitForURL(url => url.origin === 'http://localhost:3083')
    await fallback.getByRole('button', { name: 'Add workspace' }).waitFor()
    assert.equal(new URL(fallback.url()).origin, 'http://localhost:3083')
    await fallback.close()

    step = 'choosing the second employee’s independent chat'
    await alex.page.waitForURL(url => url.origin === alexChatOrigin)
    await alex.page.getByRole('button', { name: 'New session', exact: false }).first().waitFor()
    assert.equal(new URL(alex.page.url()).origin, alexChatOrigin)
    assert.equal((await alex.context.request.get(chatOrigin + '/api', { maxRedirects: 0 })).status(), 403)
    assert.equal((await maya.context.request.get(alexChatOrigin + '/api', { maxRedirects: 0 })).status(), 403)
    await alex.page.getByRole('button', { name: 'Workbench', exact: true }).click()
    passed('Maya and Alex enter their own chats and each employee’s chat API denies the other')
  }
  for (const { page } of [maya, alex]) {
    await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor()
  }

  step = 'claim and evidence isolation'
  const mp = await request(maya.page, '/claims/api/portfolio')
  const ap = await request(alex.page, '/claims/api/portfolio')
  assert.ok(mp.data.items.some(item => item.id === 'WC-101'))
  assert.ok(ap.data.items.some(item => item.id === 'WC-103'))
  assert.ok(!mp.data.items.some(item => item.id === 'WC-103'))
  assert.ok(!ap.data.items.some(item => item.id === 'WC-101'))
  for (const [page, id] of [[maya.page, 'WC-103'], [alex.page, 'WC-101'], [maya.page, 'TEST-ISOLATION'], [maya.page, 'TEST-MATTER']]) {
    assert.equal((await request(page, '/claims/api/items/' + id)).status, 404)
    assert.equal((await request(page, '/claims/api/evidence/source-' + id)).status, 404)
  }
  const shared = await request(alex.page, '/claims/api/items/WC-102')
  assert.equal(shared.data.canAct, false)
  assert.equal((await request(alex.page, '/claims/api/items/WC-102/prepare', {
    expectedVersion: shared.data.item.version, action: 'record-review',
  }, { 'X-CSRF-Token': ai.data.csrfToken })).status, 403)
  passed('owner, tenant, profile and read-only grant enforcement')

  step = 'native harness denial and request forgery checks'
  const authorityPage = desktop ? await maya.context.newPage() : maya.page
  if (desktop) await authorityPage.goto(new URL('/open-workbench', origin).href)
  assert.equal((await request(authorityPage, '/auth/me', undefined, {
    'X-Principal-Id': 'alex', 'X-Tenant-Id': 'isolation',
  })).data.user.principalId, 'maya')
  const denied = await request(authorityPage, '/api/session/create', {
    type: 'client-request', rpcId: 'claims-acceptance', method: 'session/create', payload: { args: { request: {} } },
  })
  assert.equal(denied.data.result.ok, false)
  assert.equal(denied.data.result.error.code, 'remote-access/denied')
  assert.equal((await request(authorityPage, '/auth/logout', {})).status, 403)
  assert.equal((await maya.context.request.post(new URL('/auth/logout', origin).href, {
    data: {}, headers: { Origin: 'http://example.invalid', 'X-CSRF-Token': mi.data.csrfToken },
  })).status(), 403)
  const anonymous = await browser.newContext()
  assert.equal((await anonymous.request.get(new URL('/auth/me', origin).href)).status(), 401)
  await anonymous.addCookies([{ name: 'claims_session_dev', value: 'forged-cookie', url: origin.href }])
  assert.equal((await anonymous.request.get(new URL('/auth/me', origin).href)).status(), 401)
  assert.equal((await maya.context.request.get(new URL('/connect?token=ignored', origin).href)).status(), 403)
  if (desktop) await authorityPage.close()
  passed('stock session denial, forged identity/cookie rejection, CSRF and Origin checks')

  step = 'real Workbench evidence and replay assistant'
  await maya.page.getByRole('button', { name: 'Open WC-101 Promised callback' }).click()
  await maya.page.getByRole('button', { name: 'Evidence & timeline', exact: true }).click()
  await maya.page.getByRole('button', { name: 'Source note · Diary', exact: true }).click()
  await maya.page.getByText('Synthetic source. Callback deadline this shift', { exact: true }).waitFor()
  await maya.page.getByRole('button', { name: 'Overview', exact: true }).click()
  const response = maya.page.waitForResponse(value => new URL(value.url()).pathname === '/claims/api/assist')
  await maya.page.getByRole('button', { name: 'Run assistant', exact: true }).click()
  const reply = await response
  assert.equal(reply.status(), 200)
  const result = await reply.json()
  assert.equal(result.mode, 'replay')
  assert.equal(result.subject, 'WC-101')
  assert.ok(result.text.includes('Prepare callback'))
  assert.ok(result.sources.some(source => source.id === 'source-WC-101'))
  assert.ok(!result.text.includes('RESTRICTED_EVIDENCE_CANARY'))
  await maya.page.getByText(result.text, { exact: true }).waitFor()
  passed('real evidence API and scoped replay through the native panel')

  if (process.env.CLAIMS_ACCEPTANCE_LIVE === '1') {
    step = 'local model task selection'
    await maya.page.getByLabel('Task').selectOption('compare_evidence')
    await maya.page.getByLabel('Run mode').selectOption('live')
    step = 'local model response'
    const inference = maya.page.waitForResponse(value => new URL(value.url()).pathname === '/claims/api/assist', { timeout: 100_000 })
    await maya.page.getByRole('button', { name: 'Run assistant', exact: true }).click()
    const response = await inference
    step = 'local model HTTP response ' + response.status()
    assert.equal(response.status(), 200)
    const live = await response.json()
    if (/^session-[A-Za-z0-9-]+$/.test(live.sessionId)) console.log('LIVE_SESSION: ' + live.sessionId)
    step = 'rendered local model answer'
    await maya.page.getByText(live.text, { exact: true }).waitFor()
    await maya.page.getByText(live.text, { exact: true }).scrollIntoViewIfNeeded()
    if (process.env.CLAIMS_ACCEPTANCE_SCREENSHOT) await maya.page.screenshot({ path: process.env.CLAIMS_ACCEPTANCE_SCREENSHOT, fullPage: true })
    step = 'local model selected-claim facts'
    assert.equal(live.mode, 'live')
    assert.equal(live.subject, 'WC-101')
    assert.ok(live.text.toLowerCase().includes('callback'))
    step = 'local model source citation'
    assert.ok(live.text.includes('source-WC-101'))
    assert.ok(live.sources.some(source => source.id === 'source-WC-101'))
    assert.ok(!live.text.includes('RESTRICTED_EVIDENCE_CANARY'))
    assert.ok(!/timeline (does not|shows no|has no)/i.test(live.text))
    passed('local model compared the selected evidence and cited its source')

    step = 'live priority with a time-sensitive obligation'
    await maya.page.getByLabel('Task').selectOption('explain_priority')
    await maya.page.getByPlaceholder('Ask about the selected record').fill('Why does this need attention? Give the exact deadline with its time zone and cite the source.')
    const priorityResponse=maya.page.waitForResponse(r=>r.url().endsWith('/claims/api/assist'),{timeout:100_000})
    await maya.page.getByRole('button',{name:'Run assistant',exact:true}).click()
    const priority=await priorityResponse
    assert.equal(priority.status(),200)
    const answer=await priority.json()
    assert.equal(answer.mode,'live')
    assert.equal(answer.subject,'WC-101')
    assert.match(answer.text,/callback/i)
    assert.ok(answer.text.includes('2026-11-17T15:00:00.000Z'))
    assert.ok(answer.text.includes('[source-WC-101]'))
    await maya.page.getByText(answer.text,{exact:true}).waitFor()
    passed('live priority preserved the recorded callback deadline, time zone and citation')
  }

  step = 'persisted claims session ownership'
  const saved = await request(maya.page, '/claims/api/sessions/' + result.sessionId)
  assert.equal(saved.status, 200)
  assert.equal(saved.data.text, result.text)
  assert.equal((await request(alex.page, '/claims/api/sessions/' + result.sessionId)).status, 404)
  assert.ok((await request(maya.page, '/claims/api/items/WC-101/sessions')).data.items.some(item => item.sessionId === result.sessionId))
  passed('persisted result remains bound to the creating person and claim')

  step = 'switching between Workbench and desktop chat'
  await maya.page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  if (desktop) {
    await maya.page.getByRole('button', { name: 'Open in Chat', exact: true }).click()
    await maya.page.waitForURL(url => url.origin === chatOrigin)
    await maya.page.getByRole('button', { name: 'Add workspace' }).waitFor()
    assert.equal(new URL(maya.page.url()).origin, chatOrigin)
    const editor = maya.page.locator('[data-composer-card]:visible')
    await editor.getByRole('button', { name: 'Choose scope', exact: true }).waitFor()
    await editor.getByRole('button', { name: 'Remove WC-101', exact: true }).waitFor()
    const workspace = process.env.CLAIMS_DESKTOP_TEST_WORKSPACE
    if (workspace) {
      step = 'opening a workstation folder in the native chat composer'
      await maya.page.getByRole('button', { name: 'Add workspace' }).click()
      const dialog = maya.page.getByRole('dialog', { name: 'Select Workspace Directory' })
      await dialog.getByRole('button', { name: 'Edit path' }).click()
      const path = dialog.locator('input[aria-label="Edit path"]')
      await path.fill(workspace)
      await maya.page.keyboard.press('Enter')
      await path.waitFor({ state: 'detached' })
      await dialog.getByRole('button', { name: 'Open', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      step = 'checking the selected workstation folder and editable composer'
      // Reopening an already selected folder can return focus to the picker button.
      const selected = maya.page.getByRole('button', { name: 'Choose workspace', exact: true })
      await selected.getByText(basename(workspace), { exact: true }).waitFor()
      const composer = maya.page.locator('[data-composer-input][contenteditable="true"]')
      await composer.click()
      assert.equal(await composer.evaluate(element => element === document.activeElement), true)
      passed('selected a host folder and opened its native chat composer')
    }
    await maya.page.getByRole('button', { name: 'Workbench', exact: true }).click()
  } else {
    const link = maya.page.getByRole('link', { name: 'Open in Chat', exact: true })
    await link.waitFor()
    const handoff = new URL(await link.getAttribute('href'), origin)
    const conversation = handoff.searchParams.get('conversation')
    assert.ok(conversation)
    const redirect = await maya.context.request.get(handoff.href, { maxRedirects: 0 })
    assert.equal(redirect.status(), 303)
    const destination = new URL(redirect.headers().location)
    assert.equal(destination.pathname, '/open-claims-chat')
    assert.equal(destination.searchParams.get('conversation'), conversation)
    await maya.page.getByRole('button', { name: 'Collapse', exact: true }).click()
  }
  await maya.page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor()
  assert.equal((await request(maya.page, desktop ? '/desktop/workbench/me' : '/auth/me')).data.user.principalId, 'maya')
  passed('Workbench hands off the selected claim conversation within the employee session')

  let watch, priorCookies
  if (desktop) {
    step = 'opening a revocation stream in the active desktop session'
    priorCookies = await maya.context.cookies(chatOrigin)
    const watchResponse = await fetch(chatOrigin + '/desktop/session-watch', {
      headers: { Cookie: priorCookies.map(({ name, value }) => name + '=' + value).join('; ') },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
    assert.equal(watchResponse.status, 200)
    assert.match(watchResponse.headers.get('content-type'), /^text\/event-stream/)
    watch = watchResponse.text().then(() => 'closed', error => {
      if (error.name === 'TypeError') return 'closed' // Socket destroyed on session revocation.
      return error.name
    })
  }

  step = 'visible Sign out action'
  await maya.page.getByRole('button', { name: 'Sign out', exact: true }).click()
  step = 'signed-out landing navigation'
  await maya.page.waitForURL(new URL('/auth/signed-out', origin).href)
  step = 'logged-out session check'
  // The signed-out document deliberately disallows all connections through CSP.
  assert.equal((await maya.context.request.get(new URL('/auth/me', origin).href)).status(), 401)
  if (desktop) {
    step = 'chat revocation on application sign-out'
    assert.equal(await watch, 'closed', 'The open desktop stream must close on logout')
    assert.equal((await chatTab.request.get(chatOrigin + '/api', { maxRedirects: 0 })).status(), 401)
    const replay = await browser.newContext()
    await replay.addCookies(priorCookies)
    assert.equal((await replay.request.get(chatOrigin + '/api', { maxRedirects: 0 })).status(), 401)
    await replay.close()
    assert.equal((await alex.context.request.get(alexChatOrigin + '/', { maxRedirects: 0 })).status(), 200)
    passed('sign-out closes the chat stream and revokes previously issued credentials')
  }
  assert.equal((await request(alex.page, desktop ? '/desktop/workbench/me' : '/auth/me')).status, 200)
  await maya.page.getByRole('heading', { name: 'You are signed out', exact: true }).waitFor()
  assert.equal(new URL(maya.page.url()).pathname, '/auth/signed-out')
  step = 'explicit sign-in after logout'
  await maya.page.getByRole('link', { name: 'Sign in', exact: true }).click()
  await maya.page.getByRole('list', { name: 'Pick an account' }).waitFor()
  passed('Maya logout revokes only Maya; Alex remains signed in')
} catch (error) {
  // Playwright action errors can include filled input. Do not echo provider secrets or callback URLs.
  console.error('FAIL at ' + step + ' (' + error.name + ')')
  process.exitCode = 1
} finally {
  await browser.close()
}
