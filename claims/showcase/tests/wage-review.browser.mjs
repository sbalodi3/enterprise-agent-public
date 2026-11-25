// Read-only live walkthrough on the local synthetic showcase. It saves one protected conversation.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pickEmployee } from '../../auth/tests/picker.mjs'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const app = 'http://127.0.0.1:3180'
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(25000)
  await page.goto(app + '/open-workbench')
  await pickEmployee(page, 'maya')
  await page.getByRole('button', {name:/^Open WC-102\b/}).click()
  await page.getByRole('button', { name: 'Open interactive timeline', exact: true }).click()
  const outer = page.frameLocator('iframe[title="Interactive claim timeline"]')
  const content = outer.frameLocator('iframe[title="Widget content"]')
  await content.getByRole('button').first().waitFor()
  const title = await content.getByRole('button').first().textContent()
  assert.ok(title.trim())
  console.log('PASS live timeline behind the dedicated widget proxy')
  const sent = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/claims/api/chat/turn/'))
  await page.getByRole('button', {name:'Review missing wage evidence', exact:true}).click()
  const response = await sent
  assert.equal(response.status(), 200)
  const { conversationId, turnId } = await response.json()
  const endpoint = new URL('/claims/api/chat/conversation/' + conversationId, page.url()).href
  let turn
  const deadline = Date.now() + 155000
  do {
    const snapshot = await page.request.get(endpoint)
    assert.equal(snapshot.status(), 200)
    turn = (await snapshot.json()).turns.find(t => t.id === turnId)
    if (turn?.state === 'completed' || turn?.state === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 600))
  } while (Date.now() < deadline)
  assert.equal(turn?.state, 'completed', 'Live model turn: ' + (turn?.error || turn?.state))
  assert.ok(turn.answer.sources.length)
  const review = page.locator('a2ui-surface:visible')
  await review.getByRole('button').first().click()
  await page.locator('.cc-cited:visible').first().waitFor()
  await page.getByRole('button', {name:'Back to conversation',exact:true}).click()
  await page.getByRole('link', {name:'Open in Chat',exact:true}).click()
  await page.waitForURL(url => url.hash === '#claim-chat' && url.searchParams.get('conversation') === conversationId)
  await review.getByRole('button').first().waitFor()
  console.log('PASS live A2UI ' + turn.answer.wageReview.layout + ' layout, versioned source and managed Chat reopen')
} finally {
  await browser.close()
}
