// Run against the CMS-enabled local showcase. The optional live turns only read claims.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pickEmployee } from '../../auth/tests/picker.mjs'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const app = new URL(process.env.CLAIMS_APP_ORIGIN || 'http://127.0.0.1:3180')
assert.ok(['127.0.0.1', 'localhost'].includes(app.hostname))
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' })
const detail = (page, id) => page.locator('.cw-detail > .cw-id').filter({ hasText: id })
const ready = page => page.locator('.cw-panel[aria-busy=true]').waitFor({ state: 'hidden' })
const metric = (frame, label, value) => frame.locator('#metrics > div')
  .filter({ has: frame.getByText(label, { exact: true }) }).getByText(String(value), { exact: true })
async function api(page, path) {
  const res = await page.request.get(new URL('/claims/api/' + path, app).href)
  assert.ok(res.ok(), path + ' returned ' + res.status())
  return res.json()
}
async function login(id) {
  const context = await browser.newContext({ viewport: { width: 1350, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  await page.goto(new URL('/open-workbench', app).href)
  await pickEmployee(page, id)
  await page.getByRole('searchbox', { name: 'Claim number or keywords' }).waitFor()
  assert.equal((await api(page, 'status')).cmsDataset, true)
  console.log('PASS Entra sign-in and Workbench for', id)
  return page
}
async function selectClaim(page, id) {
  await ready(page)
  const search = page.getByRole('searchbox', { name: 'Claim number or keywords' })
  await search.fill(id.toLowerCase())
  await search.press('Enter')
  await ready(page)
  assert.equal(await page.locator('.cw-list .cw-row').count(), 1, 'Matched exact claim number')
  await button(page, new RegExp('^Open ' + id + '\\b')).click()
  await detail(page, id).waitFor()
  await ready(page)
}
async function checkEmployee(page, id, otherId, closedOnly) {
  assert.equal(await page.getByLabel('Claim status').inputValue(), 'all')
  assert.equal(await page.locator('.cw-row[data-item^=CLM]').count(), 10)
  assert.equal(await page.getByLabel('Assigned adjuster').count(), 0)
  const forbidden = await page.request.get(new URL('/claims/api/items/' + otherId, app).href)
  assert.equal(forbidden.status(), 404)
  const hidden = await api(page, 'chat/search?status=all&q=' + otherId)
  assert.equal(hidden.total, 0)
  if (closedOnly) {
    await page.getByLabel('Claim status').selectOption('open')
    await ready(page)
    assert.equal(await page.locator('.cw-row').count(), 0)
  }
  await selectClaim(page, id)
  console.log('Read selected claim', id)
  const { showcase } = await api(page, 'items/' + id)
  assert.equal(await button(page, 'JURIS record').count(), 1)
  assert.equal((await api(page,'items/'+id+'/juris')).id,id)
  await button(page, 'Billings · ' + showcase.billingsAmount + ' · Open source').click()
  await page.locator('.cw-cited').getByText('Billings, deductible and litigation').waitFor()
  await page.getByRole('link', { name: 'Open PDF' }).click()
  await page.frameLocator('iframe[title="Claim PDF viewer"]').locator('#download:enabled').waitFor()
  await button(page, 'Close PDF').click()
  console.log('Opened financial extract and PDF for', id)
  await button(page, 'Overview').click()
  await button(page, 'Open interactive timeline').click()
  const timeline = page.frameLocator('iframe[title="Interactive claim timeline"]').frameLocator('iframe[title="Widget content"]')
  await ready(page)
  const eventButton = button(timeline, 'View source · Date of loss')
  if (closedOnly) await eventButton.press('Enter')
  else await eventButton.click()
  await page.locator('.cw-cited').getByText('Loss and report dates').waitFor()
  assert.equal(new URL(page.url()).searchParams.get('source'), id + '-extract')
  assert.equal(new URL(page.url()).searchParams.get('anchor'), 'dates')
  const bytes = await page.request.get(new URL('/claims/api/media/' + otherId + '/' + otherId + '-extract?format=pdf', app).href)
  assert.equal(bytes.status(), 404)
}
async function checkSummary(page, total, groups) {
  await button(page, 'Portfolio summary').click()
  const summary = page.frameLocator('iframe[title="Interactive portfolio summary"]').frameLocator('iframe[title="Widget content"]')
  await metric(summary, 'Claims', total).waitFor()
  assert.equal(await summary.locator('details').count(), groups)
  if (total === 200) {
    await metric(summary, 'Billings', '3,173,820.00').waitFor()
    await metric(summary, 'Litigated claims', 29).waitFor()
    const tops = await page.locator('.cw-portfolio-filters select').evaluateAll(selects => selects.map(s => s.offsetTop))
    assert.equal(new Set(tops).size, 1, 'Portfolio filters share a desktop row')
    await page.getByRole('combobox', { name: /^Line of business/ }).selectOption('WC')
    await metric(summary, 'Claims', 34).waitFor()
    await metric(summary, 'Billings', '632,260.00').waitFor()
    await metric(summary, 'Litigated claims', 4).waitFor()
    await summary.getByText('Workers’ compensation', { exact: true }).waitFor()
    await page.getByRole('combobox', { name: /^Line of business/ }).selectOption('')
    await metric(summary, 'Claims', 200).waitFor()
    await page.getByLabel('Assigned adjuster').selectOption('cms-adjuster-02')
    await metric(summary, 'Claims', 10).waitFor()
    await page.getByLabel('Group claims by').selectOption('status')
    await summary.getByLabel('Denied · 10 claims').waitFor()
    await page.getByLabel('Group claims by').selectOption('adjuster')
    await summary.getByLabel('Brandon Lee · 10 claims').waitFor()
  }
  await summary.locator('summary').first().press('Enter')
  const claim = button(summary, /^Open CLM-/).first()
  const id = (await claim.getAttribute('aria-label')).match(/CLM-\d{6}/)[0]
  await claim.press('Enter')
  await detail(page, id).waitFor()
  if (total === 200) {
    await button(page, 'Open interactive timeline').click()
    const timeline = page.frameLocator('iframe[title="Interactive claim timeline"]').frameLocator('iframe[title="Widget content"]')
    await button(timeline, 'View source · Date reported').press('Enter')
    await page.locator('.cw-cited').getByText('Loss and report dates').waitFor()
    await page.getByRole('link', { name: 'Open PDF' }).click()
    await page.frameLocator('iframe[title="Claim PDF viewer"]').locator('#download:enabled').waitFor()
    await button(page, 'Close PDF').click()
  }
}
async function liveApps(page, admin = false, closedOnly = false) {
  await page.route('**/desktop/presence', route => route.abort())
  for (const [name, action] of [['Preview Notice', 'Continue'], ['Add an API key to get started', 'Configure later']]) {
    const dialog = page.getByRole('dialog', { name })
    await page.addLocatorHandler(dialog, () => button(dialog, action).click())
  }
  await page.goto(new URL('/open-app', app).href)
  const composer = page.locator('[data-composer-card]:visible')
  const editor = composer.locator('[contenteditable=true]').first()
  await button(composer, 'Choose scope').waitFor({ timeout: 120000 })
  async function ask(question) {
    const admitted = page.waitForResponse(r => /\/claims\/api\/chat\/turn\//.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
    await editor.fill(question)
    await editor.press('Enter')
    const accepted = await admitted
    assert.ok(accepted.ok(), question + ' admission failed ' + accepted.status())
    const { conversationId, turnId } = await accepted.json()
    let turn
    const deadline = Date.now() + 200000
    while (Date.now() < deadline) {
      const state = await api(page, 'chat/conversation/' + conversationId)
      turn = state.turns.find(item => item.id === turnId)
      if (turn && turn.state !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 900))
    }
    assert.equal(turn?.state, 'completed', question + ' failed: ' + turn?.error)
    const settled = page.locator('.cs-transcript:visible article[data-turn-state=completed]')
      .filter({ has: page.getByText(question, { exact: true }) }).last()
    await settled.waitFor()
    return settled
  }
  if (!admin) {
    const cases = await ask('What are my open cases?')
    const open = cases.frameLocator('iframe[title="Interactive case list"]').frameLocator('iframe[title="Widget content"]')
    if (closedOnly) {
      await open.getByText('No cases match this view.').waitFor()
      await cases.getByLabel('Case list lifecycle').selectOption('all')
      await button(cases, 'Search cases').click()
    }
    const first = button(open, /^Open CLM-/).first()
    await first.waitFor()
    assert.equal(await button(open, /^Open CLM-/).count(), 10)
    const id = (await first.getAttribute('aria-label')).match(/CLM-\d{6}/)[0]
    await first.press('Enter')
    await detail(page, id).waitFor()
    if (closedOnly) return
    await button(page, 'Return to chat').click()
    await editor.waitFor()
  }
  const report = await ask(admin ? 'Show the organization portfolio summary by line of business.' : 'Show my portfolio summary by line of business.')
  const summary = report.frameLocator('iframe[title="Interactive portfolio summary"]').frameLocator('iframe[title="Widget content"]')
  await metric(summary, 'Claims', admin ? 200 : 10).waitFor()
  await summary.locator('summary').first().press('Enter')
  const row = button(summary, /^Open CLM-/).first()
  const claim = (await row.getAttribute('aria-label')).match(/CLM-\d{6}/)[0]
  await row.press('Enter')
  await detail(page, claim).waitFor()
  if (admin) {
    await button(page, 'Ask agent').click()
    await button(page, 'Open in Chat').click()
    await button(composer, 'Remove ' + claim).waitFor()
    const turn = await ask('What are the billings and deductible on this claim? Cite the financials passage.')
    const citation = turn.locator('button.cc-source-button[title=financials]')
    await citation.click()
    const facts = (await api(page, 'items/' + claim)).showcase
    const paper = page.locator('.cs-transcript:visible .cc-preview .cc-cited')
    assert.ok((await paper.innerText()).includes('Billings: ' + facts.billingsAmount + '. Deductible: ' + facts.deductibleAmount))
    await page.getByRole('link', { name: 'Open PDF' }).click()
    await page.frameLocator('iframe[title="Claim PDF viewer"]').locator('#download:enabled').waitFor()
    await button(page, 'Close PDF').click()
  }
}
try {
  if (process.argv.includes('--admin-chat-only') || process.argv.includes('--adjuster-chat-only') || process.argv.includes('--closed-chat-only')) {
    const admin = process.argv.includes('--admin-chat-only')
    const closedOnly = process.argv.includes('--closed-chat-only')
    const principal = admin ? 'claims-admin' : closedOnly ? 'cms-adjuster-02' : 'cms-adjuster-01'
    await liveApps(await login(principal), admin, closedOnly)
    console.log('PASS hosted Chat tool turns and drilldowns for', principal)
  } else {
    const aisha = await login('cms-adjuster-01')
    await checkEmployee(aisha, 'CLM-000020', 'CLM-000017', false)
    console.log('PASS active claim search, citation, PDF, timeline and denial')
    await checkSummary(aisha, 10, 3)
    const brandon = await login('cms-adjuster-02')
    await checkEmployee(brandon, 'CLM-000017', 'CLM-000020', true)
    console.log('PASS closed-only assignee and exact lookup from active view')
    const admin = await login('claims-admin')
    const allCms = new Set()
    for (;;) {
      for (const id of await admin.locator('.cw-row[data-item^=CLM]').evaluateAll(rows => rows.map(row => row.dataset.item))) {
        assert.ok(!allCms.has(id), 'No duplicate page entries')
        allCms.add(id)
      }
      const next = button(admin, 'Next page')
      if (await next.isDisabled()) break
      await next.click()
      await ready(admin)
    }
    assert.equal(allCms.size, 200)
    await admin.getByLabel('Assigned adjuster').selectOption('cms-adjuster-02')
    await ready(admin)
    assert.equal(await admin.locator('.cw-row[data-item^=CLM]').count(), 10)
    await checkSummary(admin, 200, 6)
    console.log('PASS Entra adjusters, admin, open/closed search, scoped extracts/PDF, timeline and summary drilldown')
    if (!process.argv.includes('--workbench-only')) {
      await liveApps(aisha)
      await liveApps(brandon, false, true)
      await liveApps(admin, true)
      console.log('PASS hosted employee and admin Chat, organizational summary, claim drilldown and financial citation/PDF')
    }
  }
} catch (error) {
  console.error('CMS browser check failed:', error.message)
  throw error
} finally { await browser.close() }
