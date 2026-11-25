// Run against an isolated, freshly seeded showcase. All claim writes below originate in the UI.
import { pickEmployee } from '../../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const origin = 'http://127.0.0.1:3180'
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' })
let phase = 'authenticate'
async function login(principal) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  await page.goto(origin + '/open-workbench')
  await pickEmployee(page, principal)
  await page.getByRole('heading', { name: 'My Shift', exact: true }).waitFor()
  return page
}
async function click(page, locator) {
  await page.locator('.cw-panel[aria-busy=true]').waitFor({ state: 'hidden' })
  await locator.click()
  await page.locator('.cw-panel[aria-busy=true]').waitFor({ state: 'hidden' })
}
async function checkResponse(page, path) {
  const r = await page.request.get(origin + '/claims/api/' + path)
  assert.equal(r.status(), 200, 'Read ' + path)
  return r.json()
}
async function until(fn, expected) {
  const deadline = Date.now() + 60_000
  do {
    const outcome = await fn()
    if (outcome) return outcome
    await delay(400)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for ' + expected)
}
async function refreshTo(page, locator, view = 'Reviews') {
  await until(async () => {
    if (await locator.isVisible()) return true
    await click(page, button(page, 'Refresh'))
    if ((await button(page, view).getAttribute('aria-current')) !== 'page')
      await click(page, button(page, view))
    return locator.isVisible()
  }, 'visible workflow state')
}
async function commitReview(page, itemId, action, loseAck = false) {
  const approveLabel=action==='record_wage_evidence'?'Approve and file wage evidence':'Approve exact proposal'
  const pending = page
    .locator('article.cw-entry')
    .filter({ hasText: action==='record_wage_evidence'?'File wage evidence':action })
    .filter({ has: button(page, approveLabel) })
  await refreshTo(page, pending)
  if (loseAck) {
    await click(page, button(page, 'Demo controls'))
    await page.getByLabel('Lose next approval acknowledgement').check()
  }
  const review = page.waitForResponse((r) => /\/proposals\/[^/]+\/review$/.test(r.url()))
  await click(page, button(pending, approveLabel))
  const response = await review
  assert.equal(response.status(), 200, 'Review accepted')
  const { operationId } = await response.json()
  assert.ok(operationId)
  if (loseAck) {
    await until(
      async () => (await checkResponse(page, 'operations/' + operationId)).state === 'unknown',
      'lost destination acknowledgement',
    )
    const unknown = page.locator('article.cw-entry').filter({ hasText: operationId })
    await refreshTo(page, button(unknown, 'Reconcile receipt'))
    const source = await checkResponse(page, 'items/' + itemId + '/juris')
    const actual = source.receipts.filter((r) => r.operationId === operationId)
    assert.equal(actual.length, 1, 'Destination committed exactly one effect before acknowledgement loss')
    await click(page, button(unknown, 'Reconcile receipt'))
    console.log('PASS unknown operation reconciled using the existing destination receipt')
  }
  const receipt = await until(async () => {
    const op = await checkResponse(page, 'operations/' + operationId)
    return op.state === 'confirmed' && op
  }, itemId + ' destination receipt')
  assert.match(receipt.receiptId, /^JR-/)
  await refreshTo(page, page.getByText(receipt.receiptId, { exact: true }).first())
  return receipt
}
try {
  const maya = await login('maya')
  const alex = await login('alex')
  const inspect = (item, suffix = '') => checkResponse(maya, 'items/' + item + suffix)
  assert.equal((await checkResponse(maya, 'status')).showcase, true)
  const [alexPrivate, anonymous] = await Promise.all([
    alex.request.get(origin + '/claims/api/items/WC-105/juris'),
    browser.newContext(),
  ])
  assert.equal(alexPrivate.status(), 404, 'Alex cannot read Maya’s private destination file')
  assert.equal((await anonymous.request.get(origin + '/claims/api/items/WC-105/juris')).status(), 401)
  assert.equal((await anonymous.request.post(origin + '/claims/integrations/showcase/partner')).status(), 404)
  await anonymous.close()

  phase = 'choose hosted chat'
  await maya.route('http://127.0.0.1:3181/desktop/presence', route => route.abort('connectionrefused'))
  for (const [title, label] of [
    ['Preview Notice', 'Continue'],
    ['Add an API key to get started', 'Configure later'],
  ]) {
    const dialog = maya.getByRole('dialog', { name: title })
    await maya.addLocatorHandler(dialog, () => button(dialog, label).click())
  }
  await maya.goto(origin + '/open-app')
  await maya.waitForURL(url => url.origin === 'http://127.0.0.1:3183' || url.origin === origin && url.pathname === '/chat')
  const shared = new URL(maya.url()).pathname === '/chat'
  await maya.locator('[data-composer-card]:visible').waitFor()
  if (shared) {
    const id = await maya.locator('[data-conversation-session]:visible').first().getAttribute('data-conversation-session')
    assert.ok(id)
    assert.equal((await alex.request.get(origin+'/chat?session='+id)).status(),404)
  } else assert.equal((await alex.request.get('http://127.0.0.1:3183/api', { maxRedirects: 0 })).status(), 403)
  await button(maya, 'Workbench').click()
  await maya.getByRole('heading', { name: 'My Shift', exact: true }).waitFor()
  assert.equal(new URL(maya.url()).port, shared ? '3180' : '3183')
  await button(maya, 'Return to chat').click()
  await maya.locator('[data-composer-card]:visible').waitFor()
  await button(maya, 'Workbench').click()
  await maya.getByRole('heading', { name: 'My Shift', exact: true }).waitFor()
  await maya.reload()
  await maya.getByRole('heading', { name: 'My Shift', exact: true }).waitFor()
  console.log('PASS Entra Local, separate hosted Chat and Workbench, isolated employee access')

  await button(maya, /^Open WC-102\b/).waitFor()
  if (process.env.SHOWCASE_TEST_SCREENSHOTS === '1')
    await maya.screenshot({ path: '/tmp/enterprise-agent-shift.png' })
  phase = 'wage request and signed release'
  await click(maya, button(maya, /^Open WC-102\b/))
  const initialWage = await inspect('WC-102', '/juris')
  const start = maya.waitForResponse(
    (r) => r.url().endsWith('/claims/api/wages') && r.request().method() === 'POST',
  )
  await click(maya, button(maya, 'Request wage evidence'))
  const started = await start
  assert.equal(started.status(), 200)
  const { payload:{requestId} } = await started.json()
  assert.ok(requestId)
  await click(maya, button(maya, 'Reviews'))
  await click(maya,button(maya,'Approve and send wage request'))
  const release = button(maya, 'Release partner evidence')
  await refreshTo(maya, release)
  const completion = maya.waitForResponse(
    (r) => r.url().endsWith('/items/WC-102/release') && r.request().method() === 'POST',
  )
  await click(maya, release)
  const released = await completion
  assert.equal(released.status(), 200)
  assert.deepEqual(await released.json(), { released: true, notificationDelivered: true })
  await until(
    async () =>
      (await inspect('WC-102')).proposals.find((p) => p.requestId === requestId && p.status === 'pending'),
    'wage proposal',
  )
  assert.equal((await inspect('WC-102', '/juris')).revision, initialWage.revision)
  const wageReceipt = await commitReview(
    maya,
    'WC-102',
    'record_wage_evidence',
    process.env.SHOWCASE_TEST_LOST_ACK === '1',
  )
  await click(maya, button(maya, /JURIS record/i))
  await maya.getByText(wageReceipt.receiptId, { exact: false }).first().waitFor()
  const wageRecord = await inspect('WC-102', '/juris')
  assert.equal(wageRecord.wageEvidence.requestId, requestId)
  assert.equal(wageRecord.revision, initialWage.revision + 1)
  assert.equal(wageRecord.receipts.filter((r) => r.operationId === wageReceipt.operationId).length, 1)
  console.log('PASS signed wage workflow, human approval and destination readback')

  phase = 'interactive timeline and payroll source'
  await click(maya, button(maya, 'Overview'))
  await click(maya, button(maya, 'Open interactive timeline'))
  const frame = maya.frameLocator('iframe[title="Interactive claim timeline"]').frameLocator('iframe[title="Widget content"]')
  const documents = (await inspect('WC-102')).showcase.documents.filter(
    (d) => d.title === 'Partner wage statement',
  )
  const sourceIndex = documents.findIndex((d) => d.id === 'wage-' + requestId)
  assert.ok(sourceIndex >= 0)
  const source = button(frame, 'Open document · Partner wage statement').nth(sourceIndex)
  await source.waitFor()
  assert.equal(
    await maya.locator('iframe[title="Interactive claim timeline"]').getAttribute('sandbox'),
    'allow-scripts allow-same-origin',
  )
  // Chrome can scroll the containing panel between hit-testing and clicking an offscreen sandbox frame.
  await maya.locator('iframe[title="Interactive claim timeline"]').evaluate(
    (el) =>
      new Promise((resolve) => {
        el.scrollIntoView({ block: 'center', behavior: 'instant' })
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      }),
  )
  await source.click()
  await maya
    .getByText(/Gross earnings USD 1830\.00/)
    .first()
    .waitFor()
  const pdf = maya.getByRole('link', { name: /PDF/i }).first()
  const pdfUrl = new URL(await pdf.getAttribute('href'), origin)
  assert.equal(new URL(maya.url()).searchParams.get('source'), 'wage-' + requestId)
  assert.equal(new URL(maya.url()).searchParams.get('anchor'), 'coverage')
  assert.equal(pdfUrl.origin, origin)
  await pdf.click()
  const viewer = maya.frameLocator('iframe[title="Claim PDF viewer"]')
  await viewer.locator('figcaption').filter({ hasText: '1830.00' }).first().waitFor({ state: 'attached' })
  const save = maya.waitForEvent('download')
  await viewer.getByRole('button', { name: 'Download' }).click()
  assert.ok((await save).suggestedFilename().endsWith('.pdf'))
  const newTab = maya.waitForEvent('popup')
  await viewer.getByRole('link', { name: 'Open in new tab' }).click()
  const standalone = await newTab
  await standalone.locator('#status').filter({ hasText: 'Cited passage coverage' }).waitFor()
  await standalone.close()
  await maya.getByRole('button', { name: 'Close PDF' }).click()
  const selectedUrl = maya.url()
  await maya.reload()
  await maya
    .getByText(/14 of 364 requested days\. Partial coverage/)
    .first()
    .waitFor()
  assert.equal(
    new URL(maya.url()).searchParams.get('source'),
    new URL(selectedUrl).searchParams.get('source'),
  )
  assert.equal(new URL(maya.url()).searchParams.get('record'), 'WC-102')
  console.log('PASS sandboxed MCP source, PDF, partial requested period and refreshable deep link')

  phase = 'missed call and intake review'
  const shiftCount = await maya.locator('.cw-shift-count strong').allTextContents()
  const workBeforeCall = shiftCount.reduce((a, n) => a + Number(n), 0)
  await click(maya, button(maya, 'Deliver missed call'))
  const workAfterCall = await maya.locator('.cw-shift-count strong').allTextContents()
  assert.equal(
    workAfterCall.reduce((a, n) => a + Number(n), 0),
    workBeforeCall + 1,
  )
  await click(maya, button(maya, /^(?:Agent )?Inbox$/i))
  await click(maya, button(maya, 'Open IN-201').first())
  await click(maya, button(maya, 'Intake Review'))
  const claimIntake = button(maya, 'Claim this intake')
  if (await claimIntake.isVisible()) await click(maya, claimIntake)
  const audio = maya.locator('audio')
  await audio.waitFor()
  if (process.env.SHOWCASE_TEST_SCREENSHOTS === '1')
    await maya.screenshot({ path: '/tmp/enterprise-agent-intake.png' })
  const audioUrl = new URL(await audio.getAttribute('src'), origin)
  assert.equal(audioUrl.origin, origin)
  const audioResponse = await maya.request.get(audioUrl.href, { headers: { range: 'bytes=0-31' } })
  assert.equal(audioResponse.status(), 206)
  assert.equal((await audioResponse.body()).subarray(0, 4).toString(), 'RIFF')
  assert.equal((await alex.request.get(audioUrl.href)).status(), 404)
  const seek = button(maya, /^Play /).nth(1)
  await seek.click()
  await until(() => audio.evaluate((el) => el.currentTime > 0 && !el.paused), 'playable transcript cue')
  await audio.evaluate((el) => el.pause())
  const candidates = maya.locator('.cw-candidate')
  assert.equal(await candidates.count(), 2)
  assert.ok((await candidates.filter({ hasText: 'WC-105' }).textContent()).includes('Cedar Dock'))
  assert.ok((await candidates.filter({ hasText: 'WC-107' }).textContent()).includes('Alder Yard'))
  const original = await inspect('WC-105', '/juris')
  const other = await inspect('WC-107', '/juris')
  assert.ok(
    !original.intakeTranscripts.some((t) => t.intakeId === 'IN-201'),
    'Use a fresh showcase for the staged call',
  )
  await maya.getByLabel(/target claim/i).selectOption('WC-105')
  await click(maya, button(maya, 'Prepare filing'))
  assert.equal((await inspect('WC-105', '/juris')).revision, original.revision)
  await click(maya, button(maya, 'Reviews'))
  const intakeReceipt = await commitReview(maya, 'IN-201', 'file_intake_transcript')
  const target = await inspect('WC-105', '/juris')
  assert.equal(target.receipts.filter((r) => r.operationId === intakeReceipt.operationId).length, 1)
  assert.equal(target.intakeTranscripts.filter((t) => t.intakeId === 'IN-201').length, 1)
  assert.equal(target.revision, original.revision + 1)
  assert.equal((await inspect('WC-107', '/juris')).revision, other.revision)
  await click(maya, button(maya, 'Intake Review'))
  await click(maya, button(maya, 'Open filed claim WC-105'))
  assert.equal(new URL(maya.url()).searchParams.get('record'), 'WC-105')
  await click(maya, button(maya, 'JURIS record'))
  await maya.getByText(intakeReceipt.receiptId, { exact: true }).waitFor()
  console.log(
    'PASS authorized call audio, examiner-selected match, filed claim link and one destination receipt',
  )

  phase = 'second examiner evidence comparison'
  await click(alex, button(alex, /^Open WC-103\b/))
  await alex.getByRole('combobox', { name: /^Task\b/ }).selectOption('compare_evidence')
  await alex.getByRole('combobox', { name: /^Run mode\b/ }).selectOption('replay')
  const compared = alex.waitForResponse((r) => r.url().endsWith('/claims/api/assist'))
  await click(alex, button(alex, 'Run assistant'))
  const replay = await compared
  assert.equal(replay.status(), 200)
  const answer = await replay.json()
  assert.equal(answer.mode, 'replay')
  assert.equal(answer.subject, 'WC-103')
  assert.ok(answer.text.includes('November 9') && answer.text.includes('November 10'))
  assert.deepEqual(new Set(answer.sources.map((s) => s.id)), new Set(['WC-103-report', 'WC-103-shift']))
  assert.equal((await maya.request.get(origin + '/claims/api/sessions/' + answer.sessionId)).status(), 404)
  console.log('PASS Alex’s deterministic comparison cites both conflicting records and stays scoped to Alex')
} catch (error) {
  // Login errors may include an authorization URL. Report the phase only.
  if (phase === 'authenticate') throw new Error('Could not sign in to the local showcase')
  throw new Error('Showcase acceptance failed during ' + phase, { cause: error })
} finally {
  await browser.close()
}
