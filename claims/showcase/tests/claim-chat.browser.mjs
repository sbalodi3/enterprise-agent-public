// Live, read-only showcase walkthrough. Start the isolated showcase with --model before running.
import { pickEmployee } from '../../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const app = 'http://127.0.0.1:3180'
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' })
const root = page => page.locator('.cc-session:visible')
const checks = []
const instrument = page => {
  page.on('pageerror', err => console.error('Browser rendering error:', err.name, err.message.slice(0, 180)))
}
async function login(user) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  instrument(page)
  page.setDefaultTimeout(20000)
  await page.goto(app + '/open-workbench')
  await pickEmployee(page, user)
  return page
}

async function measure(name, action) {
  const start = Date.now()
  const res = await action()
  checks.push(name)
  console.log('PASS', name, Math.round((Date.now() - start) / 1000) + 's')
  return res
}

async function ask(page, question) {
  const session = root(page)
  const sent = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/claims/api/chat/turn/'))
  const native = page.locator('[data-composer-card]:visible [contenteditable="true"]').first()
  if (await native.count()) {
    await native.fill(question)
    await native.press('Enter')
  } else {
    await session.getByRole('textbox').fill(question)
    await button(session, 'Send').click()
  }
  return awaitResult(page, question, await sent)
}

async function awaitResult(page, question, response) {
  const session = root(page)
  assert.equal(response.status(), 200, 'Turn accepted')
  const { conversationId, turnId } = await response.json()
  const url = new URL('/claims/api/chat/conversation/' + conversationId, page.url()).href
  const deadline = Date.now() + 175000
  do {
    const result = await page.request.get(url)
    assert.ok(result.ok(), 'Authorized conversation read')
    const turn = (await result.json()).turns.find(t => t.id === turnId)
    if (turn?.state === 'failed') throw Error('Live turn failed: ' + turn.error + ' after ' + turn.activity.map(a => a.tool || a.id).join(', '))
    if (turn?.state === 'completed') {
      const article = session.locator('article.cc-turn').filter({ hasText: question }).last()
      try { await article.locator('.cc-answer').waitFor() }
      catch (err) {
        console.error('Saved answer exists. Visible turn states:', await session.locator('article.cc-turn').evaluateAll(elements => elements.map(e => e.dataset.turnState)))
        throw err
      }
      return { conversationId, turn, article }
    }
    await delay(500)
  } while (Date.now() < deadline)
  throw Error('Live turn did not settle')
}

async function walkthrough() {
  const page = await login('alex')
  await button(page, /^Open WC-103\b/).click()
  await button(page, 'Ask agent').click()
  const chat = root(page)
  await chat.getByText('Claim · WC-103', { exact: true }).first().waitFor()
  await chat.getByRole('textbox').fill('Draft before collapse')
  await button(chat, 'Collapse').click()
  await button(page, 'Ask agent').click()
  assert.equal(await chat.getByRole('textbox').inputValue(), 'Draft before collapse')
  const conflict = await measure('Live date comparison from both WC-103 documents', async () => {
    const result = await ask(page, 'Why are there two incident dates?')
    const { answer, activity } = result.turn
    assert.match(answer.text, /November 9/)
    assert.match(answer.text, /November 10/)
    assert.match(answer.text, /verif|unresolved|review|disagree/i)
    for (const [id, anchor] of [['WC-103-report', 'account'], ['WC-103-shift', 'date']]) {
      assert.ok(answer.sources.some(s => s.documentId === id && s.anchorId === anchor && s.documentVersion === 1))
    }
    assert.ok(activity.filter(s => s.tool === 'read_evidence' && s.state === 'completed').length >= 2)
    return result
  })
  await measure('Both anchored originals and protected PDFs open in Chat', async () => {
    const panel = chat.getByRole('region', { name: 'Source document' })
    await button(conflict.article, 'Supervisor incident report').first().click()
    for (const [title, date, anchor] of [['Supervisor incident report', 'November 9', 'account'], ['Shift handover note', 'November 10', 'date']]) {
      await button(panel, title).first().click()
      await panel.locator('.cc-cited').filter({ hasText: date }).waitFor()
      const href = await panel.getByRole('link', { name: 'Open PDF' }).getAttribute('href')
      assert.ok(href.endsWith('#nameddest=' + anchor))
      await panel.getByRole('link', { name: 'Open PDF' }).click()
      const viewer = page.frameLocator('iframe[title="Claim PDF viewer"]')
      await viewer.locator('#status').filter({ hasText: 'Cited passage ' + anchor }).waitFor()
      assert.ok((await viewer.locator('figcaption').allTextContents()).join(' ').includes(date))
      await page.getByRole('button', { name: 'Close PDF' }).click()
    }
    await button(panel, 'Back to conversation').click()
  })
  await chat.getByRole('link', { name: 'Open in Chat' }).click()
  const full = page
  full.setDefaultTimeout(20000)
  for (const [label, action] of [['Preview Notice', 'Continue'], ['Add an API key to get started', 'Configure later']])
    await full.addLocatorHandler(full.getByRole('dialog', { name: label }), () => button(full, action).click())
  await full.waitForURL(url => url.hash === '#claim-chat' && url.searchParams.get('conversation') === conflict.conversationId)
  await root(full).locator('.cc-source-button').first().waitFor()
  await measure('Hosted follow-up displays the timeline in the same conversation', async () => {
    const result = await ask(full, 'Show me the timeline.')
    assert.equal(result.conversationId, conflict.conversationId)
    assert.equal(result.turn.activity.filter(a => a.tool === 'claim_timeline' && a.state === 'completed').length, 1)
    const rows = result.turn.answer.timeline.sources
    assert.ok(rows.some(s => s.id === 'WC-103-report' && s.at === '2026-11-09T19:15:00.000Z'))
    assert.ok(rows.some(s => s.id === 'WC-103-shift' && s.at === '2026-11-17T14:00:00.000Z'))
    await result.article.frameLocator('iframe').frameLocator('iframe[title="Widget content"]').getByRole('button', { name: 'Open document · Shift handover note' }).click()
    await root(full).getByRole('region', { name: 'Source document' }).locator('.cc-cited').waitFor()
    await button(root(full), 'Back to conversation').click()
  })
  await measure('Saved answers reopen for Alex and are inaccessible to Maya', async () => {
    const href = full.url()
    await full.reload()
    await root(full).locator('.cc-source-button').first().waitFor()
    const maya = await login('maya')
    assert.equal((await maya.request.get(app + '/claims/api/chat/conversation/' + conflict.conversationId)).status(), 404)
    await maya.context().close()
    await page.goto(app + '/?mode=workbench#workbench')
    await button(page, 'Sign out').click()
    await page.waitForURL(url => url.pathname === '/auth/signed-out')
    assert.equal((await page.request.get(app + '/claims/api/chat/conversation/' + conflict.conversationId)).status(), 401)
    await full.context().close()
    const again = await login('alex')
    await again.goto(href)
    await root(again).locator('.cc-source-button').first().waitFor()
    await again.context().close()
  })
  const portfolio = await login('alex')
  await button(portfolio, 'Ask agent').click()
  await measure('Live portfolio due-today query at the synthetic shift clock', async () => {
    const { turn } = await ask(portfolio, 'Which of my assigned claims have a deadline later today?')
    assert.match(turn.answer.text, /WC-108[\s\S]*WC-104/)
    assert.match(turn.answer.text, /4:30 PM UTC/)
    assert.match(turn.answer.text, /6:00 PM UTC/)
    assert.doesNotMatch(turn.answer.text, /WC-110/)
    assert.ok(turn.activity.some(a => a.tool === 'search_claims'))
  })
}

async function compareFromPortfolio() {
  const page = await login('alex')
  await button(page, 'Ask agent').click()
  const question = 'Compare the next steps and supporting documents for WC-103 and WC-104.'
  const candidates = await measure('Portfolio proposes an editable set using summaries', async () => {
    const result = await ask(page, question)
    assert.deepEqual(new Set(result.turn.answer.suggestedClaims.map(item => item.id)), new Set(['WC-103', 'WC-104']))
    assert.ok(result.turn.activity.every(a => !a.tool || a.tool === 'search_claims'))
    return result.article.getByRole('group', { name: 'Claims to compare' })
  })
  await measure('Confirmed comparison reads each selected claim and groups its sources', async () => {
    const sent = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/claims/api/chat/turn/'))
    await button(candidates, 'Compare selected').click()
    const result = await awaitResult(page, question, await sent)
    const sources = result.turn.answer.sources
    assert.deepEqual(new Set(sources.map(s => s.claimId)), new Set(['WC-103', 'WC-104']))
    assert.ok(sources.some(s => s.documentId === 'WC-104-report' && s.anchorId === 'followup'))
    assert.match(result.turn.answer.text, /18:00 UTC/)
    await result.article.locator('.cc-sources').filter({ hasText: 'WC-104' }).waitFor()
  })
}

try {
  if (process.argv.includes('--comparison')) await compareFromPortfolio()
  else await walkthrough()
  console.log('Completed', checks.length, 'live checks.')
} finally {
  await browser.close()
}
