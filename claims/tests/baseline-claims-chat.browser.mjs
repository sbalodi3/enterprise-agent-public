// Native workstation regression against the baseline synthetic demo and its Maya companion.
import { pickEmployee } from '../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')

const origin = 'http://localhost:3080'
const workstation = 'http://localhost:3081'
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const previews = process.argv.includes('--previews') ? new URL('../../.artifacts/baseline-chat-previews/', import.meta.url) : null
if (previews) await mkdir(previews, { recursive: true })
const button = (root, name) => root.getByRole('button', { name, exact: true })

async function openSidebar(page) {
  const opener = page.locator('[data-sidebar-opener]:visible')
  if (await opener.count()) await opener.first().click()
}

try {
  const context = await browser.newContext({ viewport: { width: 536, height: 587 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  for (const [title, confirm] of [['Preview Notice', 'Continue'], ['Add an API key to get started', 'Configure later']]) {
    await page.addLocatorHandler(page.getByRole('dialog', { name: title }), () => button(page, confirm).click())
  }
  await page.goto(origin + (process.argv.includes('--shared') ? '/open-companion' : '/open-app'))
  await pickEmployee(page, 'maya')
  await page.waitForURL(url => url.origin === workstation)
  const composer = page.locator('[data-composer-card]:visible')
  const trigger = button(composer, 'Choose scope')
  await trigger.waitFor()
  await openSidebar(page)
  await button(page, 'Workbench').click()
  const entry = button(page, 'Ask agent')
  await entry.waitFor()
  await entry.click({ trial: true })
  const sidebarBounds = await entry.boundingBox()
  assert.ok(sidebarBounds && sidebarBounds.x >= 0 && sidebarBounds.x + sidebarBounds.width <= 536 &&
    sidebarBounds.y >= 0 && sidebarBounds.y + sidebarBounds.height <= 587, 'claims entry should fit the visible Workbench: ' + JSON.stringify(sidebarBounds))
  if (previews) await entry.screenshot({ path: fileURLToPath(new URL('claims-agent-chat-entry.png', previews)) })
  await entry.click()
  await button(page, 'Open in Chat').click()
  await page.waitForURL(url => url.origin === workstation && url.searchParams.has('conversation'))
  await trigger.waitFor()
  await trigger.click({ trial: true })
  const bounds = await trigger.boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 536 && bounds.y >= 0 &&
    bounds.y + bounds.height <= 587, 'scope control should fit the narrow composer: ' + JSON.stringify(bounds))
  if (previews) {
    const mode = composer.getByText('Workspace Write', { exact: true }).first()
    const neighbor = await mode.count() ? await mode.boundingBox() : null
    if (neighbor) {
      const x = Math.max(0, Math.floor(Math.min(neighbor.x, bounds.x)) - 4)
      const y = Math.max(0, Math.floor(Math.min(neighbor.y, bounds.y)) - 4)
      const right = Math.min(536, Math.ceil(Math.max(neighbor.x + neighbor.width, bounds.x + bounds.width)) + 4)
      const bottom = Math.min(587, Math.ceil(Math.max(neighbor.y + neighbor.height, bounds.y + bounds.height)) + 4)
      await page.screenshot({ path: fileURLToPath(new URL('composer-controls.png', previews)),
        clip: { x, y, width: right - x, height: bottom - y } })
    }
    await trigger.screenshot({ path: fileURLToPath(new URL('choose-scope.png', previews)) })
  }
  await trigger.click()
  const picker = page.getByRole('dialog', { name: 'Choose scope' })
  await button(picker, 'Documents for WC-101').click()
  const status = picker.getByRole('combobox', { name: 'Claim status' })
  assert.ok(await status.isVisible())
  const note = picker.getByRole('checkbox', { name: 'Source note Source note', exact: true })
  await note.check()
  assert.equal(await button(picker, 'Documents for WC-103').count(), 0)
  await button(picker, 'Apply scope').click()
  await button(composer, 'Remove WC-101').waitFor()
  const id = new URL(page.url()).searchParams.get('conversation')
  assert.ok(id, 'a protected conversation is linked to the selected native session')
  const record = await page.evaluate(async id => {
    const reply = await fetch('/claims/api/chat/conversation/' + id)
    if (!reply.ok) throw Error('Unable to read selected scope: ' + reply.status)
    return reply.json()
  }, id)
  assert.deepEqual(record.scope.documents, { 'WC-101': ['source-WC-101'] })
  await page.reload()
  await button(composer, 'Choose scope').waitFor()
  await button(composer, 'Remove WC-101').waitFor()
  assert.equal(new URL(page.url()).searchParams.get('conversation'), id)
  const direct = await page.context().newPage()
  await direct.goto(workstation + '/')
  await button(direct.locator('[data-composer-card]:visible'), 'Choose scope').waitFor()
  await direct.close()
  await page.bringToFront()
  console.log('PASS direct visit to the signed-in localhost:3081 root shows Choose scope')
  console.log('PASS Ask agent handoff, native Mac Chat and scoped source note at 536×587')
  if (process.argv.includes('--turn')) {
    const input = composer.locator('[contenteditable=true]').first()
    const admitted = page.waitForResponse(r => /\/claims\/api\/chat\/turn\//.test(r.url()) && r.request().method() === 'POST')
    await input.fill('Summarize the selected source note about the callback.')
    await input.press('Enter')
    assert.ok((await admitted).ok(), 'protected turn should be accepted')
    const finished = page.locator('.cs-transcript article.cc-turn:is([data-turn-state=completed],[data-turn-state=failed])').last()
    await finished.waitFor({ timeout: 170000 })
    assert.equal(await finished.getAttribute('data-turn-state'), 'completed')
    await button(finished, 'Source note').first().click()
    await page.getByRole('region', { name: 'Source document' }).getByText(/Callback deadline this shift/).first().waitFor()
    console.log('PASS local model read from the selected note and opened its cited passage')
  }
} finally {
  await browser.close()
}
