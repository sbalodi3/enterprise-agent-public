// Exercise the actual Workbench handoff and native composer against the synthetic showcase.
import { pickEmployee } from '../../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const origin = 'http://127.0.0.1:3180'
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const alex = process.env.CLAIMS_SCOPE_PERSONA === 'alex'
const primary = alex ? 'WC-103' : 'WC-101', secondary = alex ? 'WC-104' : 'WC-102'
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const requests = []
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/claims/api/chat/') || url.pathname === '/open-claims-chat') {
      requests.push([response.request().method(), url.pathname, response.status()])
    }
  })
  page.setDefaultTimeout(18000)
  if (process.argv.includes('--hosted')) await page.route('http://127.0.0.1:3181/desktop/presence', route => route.abort('connectionrefused'))
  await page.goto(origin + (process.argv.includes('--workstation') ? '/open-app' : '/open-workbench'))
  await pickEmployee(page, alex ? 'alex' : 'maya')
  for (const [label, target] of [['Preview Notice','Continue'], ['Add an API key to get started','Configure later']]) {
    await page.addLocatorHandler(page.getByRole('dialog', { name: label }), () => button(page, target).click())
  }
  if (process.argv.includes('--workstation')) {
    await page.waitForURL(url => url.port === '3181')
    await button(page, 'Workbench').click()
    await page.waitForURL(url => url.port === '3181' && url.hash === '#workbench')
    console.log('PASS sign-in opens local Chat and returns directly to Workbench')
  }
  await page.getByRole('button', { name: new RegExp('^Open ' + primary + '\\b') }).click()
  await button(page, 'Ask agent').click()
  const handoff = page.getByRole(process.argv.includes('--workstation') ? 'button' : 'link', { name: 'Open in Chat', exact: true })
  await handoff.click()
  const editor = page.locator('[data-composer-card]:visible')
  await button(editor, 'Choose scope').waitFor()
  try { await button(editor, 'Remove ' + primary).waitFor() } catch (error) {
    console.error('Native handoff diagnostic:', { port: new URL(page.url()).port, path: new URL(page.url()).pathname,
      requests, notices: await editor.locator('.cs-notice').allTextContents(), sessions: await page.locator('[data-conversation-content]:visible').count() })
    throw error
  }
  assert.equal(await editor.locator('[contenteditable=true]').count(), 1)
  const shared = new URL(page.url()).pathname === '/chat'
  if (alex) assert.equal(new URL(page.url()).port, shared ? '3180' : '3184')
  if (process.argv.includes('--hosted') || process.argv.includes('--offline-companion')) assert.equal(new URL(page.url()).port, shared ? '3180' : '3183')
  const entry = await page.evaluate(() => new URL(location.href).searchParams.get('conversation'))
  assert.ok(entry, 'native session must have its own durable claims thread')
  await button(editor, 'Choose scope').click()
  const picker = page.getByRole('dialog', { name: 'Choose scope' })
  await picker.getByRole('checkbox', { name: 'Select ' + primary }).waitFor()
  assert.equal(await picker.getByRole('checkbox', { name: 'Select ' + (alex ? 'WC-101' : 'WC-103') }).count(), 0)
  await picker.getByRole('combobox').selectOption('closed')
  await picker.getByRole('checkbox', { name: 'Select ' + primary }).waitFor({ state: 'hidden' })
  await picker.getByRole('combobox').selectOption('all')
  await button(picker, 'Documents for ' + primary).click()
  const documents = picker.locator('.cs-docs input')
  await documents.first().waitFor()
  const count = await documents.count()
  assert.ok(count >= (alex ? 2 : 1))
  await documents.first().uncheck()
  if (count === 1) await documents.first().check()
  const another = picker.getByRole('checkbox', { name: 'Select ' + secondary })
  await another.check()
  await button(picker, 'Apply scope').click()
  await button(editor, 'Remove ' + secondary).waitFor()
  assert.equal(await editor.locator('.cs-chip').count(), 2)
  const updated = await page.evaluate(async id => (await fetch('/claims/api/chat/conversation/' + id)).json(), entry)
  assert.deepEqual(updated.scope.claimIds, [primary, secondary])
  assert.equal(updated.scope.documents[primary].length, count === 1 ? 1 : count - 1)
  assert.ok(updated.scopeRevision > 1)
  await page.reload()
  await button(editor, 'Remove ' + secondary).waitFor()
  await button(editor, 'Choose scope').click()
  await button(picker, 'Documents for ' + primary).click()
  await documents.first().waitFor()
  assert.equal(await documents.first().isChecked(), count === 1)
  await button(picker, 'Cancel').click()
  await button(page, 'New session').last().click()
  await button(editor, 'Remove ' + primary).waitFor({ state: 'hidden' })
  await button(editor, 'Choose scope').waitFor()
  assert.equal(await editor.locator('.cs-chip').count(), 0)
  if (process.argv.includes('--workstation')) {
    assert.equal(new URL(page.url()).port, '3181')
    const folder = fileURLToPath(new URL('../../../.artifacts/claims-showcase/workstation-folder-demo', import.meta.url))
    await mkdir(folder, { recursive: true })
    await button(page, 'Add workspace').click()
    const directory = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await button(directory, 'Edit path').click()
    const path = directory.getByRole('textbox', { name: 'Edit path' })
    await path.fill(folder); await path.press('Enter')
    await path.waitFor({ state: 'detached' })
    await button(directory, 'Open').click(); await directory.waitFor({ state: 'hidden' })
    await button(editor, 'Choose scope').waitFor()
    assert.equal(await editor.locator('[contenteditable=true]').count(), 1)
    console.log('PASS real workstation 3181; connected a Mac folder using the native directory picker')
  }
  if (process.argv.includes('--turns')) {
    const text = editor.locator('[contenteditable=true]').first()
    const admitted = page.waitForResponse(r => r.request().method() === 'POST' && /\/claims\/api\/chat\/turn\//.test(r.url()))
    await text.fill('Show the timeline for claim ' + primary)
    await text.press('Enter')
    const receipt = await admitted
    assert.ok(receipt.ok())
    console.log('PASS inferred scope admitted a protected turn')
    const routedId = (await receipt.json()).conversationId
    await button(editor, 'Remove ' + primary).waitFor()
    const settled = page.locator('.cs-transcript article.cc-turn:is([data-turn-state=completed],[data-turn-state=failed])').last()
    await settled.waitFor({ timeout: 170000 })
    assert.equal(await settled.getAttribute('data-turn-state'), 'completed', 'The synthetic live claims turn must complete')
    console.log('PASS native transcript rendered a completed claims turn')
    const before = await page.locator('[data-conversation-content]:visible').getAttribute('data-conversation-session')
    await button(editor, 'Remove ' + primary).click()
    await button(editor, 'Remove ' + primary).waitFor({ state: 'hidden' })
    await page.getByRole('region', { name: 'Earlier conversation history' }).getByText('Show the timeline for claim ' + primary, { exact: true }).waitFor()
    const after = await page.locator('[data-conversation-content]:visible').getAttribute('data-conversation-session')
    assert.notEqual(before, after, 'clearing protected scope creates a fresh ordinary workspace context')
    assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get('conversation')), routedId)
    const routing = page.waitForResponse(r => r.request().method() === 'POST' && /\/claims\/api\/chat\/route$/.test(r.url()))
    await text.fill('What is two plus two?')
    await text.press('Enter')
    const ordinary = await (await routing).json()
    assert.equal(ordinary.action, 'workspace')
    console.log('PASS inferred claim, live protected timeline, retained history, fresh workspace context and workspace routing')
  }
  console.log('PASS Workbench → native Claims Agent; assigned picker; document subsets; same thread; reload; New session')
} finally { await browser.close() }
