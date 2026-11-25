// End-to-end check of the employee-facing Cases MCP App hosted in native Chat.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pickEmployee } from '../../auth/tests/picker.mjs'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const app = new URL(process.env.CLAIMS_APP_ORIGIN || 'http://127.0.0.1:3180')
assert.ok(['127.0.0.1','localhost'].includes(app.hostname))
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const context = await browser.newContext({ viewport: { width: 1400, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(25000)
const button = (scope, name) => scope.getByRole('button', { name, exact: typeof name === 'string' })
try {
  await page.route('**/desktop/presence', route => route.abort())
  for (const [name, action] of [['Preview Notice','Continue'],['Add an API key to get started','Configure later']]) {
    const dialog = page.getByRole('dialog', { name })
    await page.addLocatorHandler(dialog, () => button(dialog, action).click())
  }
  await page.goto(new URL('/open-app', app).href)
  await pickEmployee(page, 'claims-admin')
  console.log('Selected claims-admin in Entra Local.')
  const composer = page.locator('[data-composer-card]:visible')
  await button(composer, 'Choose scope').waitFor({ timeout: 120000 })
  console.log('Opened hosted Chat.')
  const shared = new URL(page.url()).pathname === '/chat'
  const privateChat = new URL(page.url())
  privateChat.port = '3201'
  privateChat.pathname = '/desktop/workbench/me'
  assert.equal((await page.request.get(privateChat.href)).status(), shared ? 404 : 403)
  const connections = await page.request.get(new URL('/claims/api/connections', page.url()).href)
  assert.equal(connections.status(), 200)
  const outlook = (await connections.json()).apps.find(a => a.id === 'outlook-mail')
  assert.equal(outlook.status, 'off')
  assert.equal(outlook.available, false)
  assert.equal(outlook.address, undefined)
  console.log('PASS the administrator has no mailbox grant, and the old employee URL cannot serve mailbox data.')
  const editor = composer.locator('[contenteditable=true]').first()
  const question = 'List all claims across adjusters.'
  await editor.fill(question)
  await editor.press('Enter')
  console.log('Submitted organization Cases request.')
  const turn = page.locator('.cs-transcript:visible article[data-turn-state]').filter({
    has: page.getByText(question, { exact: true }),
  }).last()
  const host = turn.locator('.cc-case-explorer')
  await host.waitFor({ timeout: 200000 })
  const frame = host.frameLocator('iframe[title="Interactive case list"]').frameLocator('iframe[title="Widget content"]')
  const search = host.getByRole('searchbox', { name: 'Search case list' })
  const lifecycle = host.getByLabel('Case list lifecycle')
  const line = host.getByLabel('Case list business line')
  const adjuster = host.getByLabel('Case list assigned adjuster')
  async function submit(name = 'Search cases') {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/claims/api/chat/search' && r.request().method() === 'GET')
    await button(host, name).click()
    const result = await response
    assert.equal(result.status(), 200)
    return result.json()
  }
  async function labeledCount(label, count) {
    await frame.getByText(label, { exact: true }).waitFor()
    assert.equal(await button(frame, /^Open CLM-/).count(), count)
  }
  await search.fill('clm-000017')
  const exact = await submit()
  await labeledCount('1 case', 1)
  await button(frame, /^Open CLM-000017/).waitFor()
  assert.equal(await frame.locator('.case-copy strong').innerText(), exact.items[0].reason)
  console.log('PASS canonical lowercase claim lookup in the Chat-hosted Cases App.')

  await search.fill('')
  await lifecycle.selectOption('closed')
  await line.selectOption('WC')
  const first = await submit()
  assert.equal(first.total, 20)
  await labeledCount('Showing 12 of 20 cases', 12)
  const second = await submit('Next cases')
  assert.equal(second.total, 20)
  await labeledCount('Showing 8 of 20 cases', 8)
  assert.equal(new Set([...first.items,...second.items].map(item => item.id)).size, 20)
  assert.ok([...first.items,...second.items].every(item => item.lob === 'WC' && ['Closed','Denied','Paid'].includes(item.sourceStatus)))
  await button(host, 'Previous cases').click()
  await labeledCount('Showing 12 of 20 cases', 12)
  await lifecycle.selectOption('open')
  await line.selectOption('HOME')
  const home = await submit()
  assert.equal(home.total, 13)
  await labeledCount('Showing 12 of 13 cases', 12)
  assert.ok(home.items.every(item => item.lob === 'HOME' && ['Open','Under Investigation'].includes(item.sourceStatus)))
  console.log('PASS 20 closed WC cases over pages of 12 and 8, then 13 active HOME cases.')

  await adjuster.selectOption({ label: 'Brandon Lee' })
  await lifecycle.selectOption('all')
  await line.selectOption('')
  const assigned = await submit()
  assert.equal(assigned.total, 10)
  await labeledCount('10 cases', 10)
  assert.ok(assigned.items.every(item => item.ownerId === 'cms-adjuster-02'))
  await button(frame, /^Open CLM-000017/).click()
  await page.locator('.cw-detail > .cw-id').filter({ hasText: 'CLM-000017' }).waitFor()
  console.log('PASS admin selected Brandon Lee and opened CLM-000017 from the sandboxed Cases iframe in Workbench.')
  await button(page, 'Return to chat').click()
  await editor.waitFor()
  const denied = 'What are total billings for denied claims?'
  await editor.fill(denied)
  await editor.press('Enter')
  const summaryTurn = page.locator('.cs-transcript:visible article[data-turn-state]').filter({
    has: page.getByText(denied, { exact: true }),
  }).last()
  const summary = summaryTurn.frameLocator('iframe[title="Interactive portfolio summary"]').frameLocator('iframe[title="Widget content"]')
  await summary.locator('#metrics').getByText('20', { exact: true }).waitFor({ timeout: 200000 })
  assert.equal(await summary.locator('#metrics div').filter({hasText:'Billings'}).locator('dd').innerText(), '0.00')
  console.log('PASS live denied-only billing summary returned 20 claims and 0.00 billings.')
} catch (error) {
  console.log('Cases browser state:', page.url(), (await page.locator('body').innerText()).slice(-2400))
  throw error
} finally {
  await context.close()
  await browser.close()
}
