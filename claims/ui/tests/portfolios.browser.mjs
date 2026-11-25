// Render the production Workbench against synthetic department API responses.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { records } from '../../portfolios/fixtures.mjs'

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const errors = []
try {
  for (const department of ['legal', 'finance']) {
    const legal = department === 'legal'
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
    const page = await ctx.newPage()
    page.on('pageerror', error => errors.push(error.message))
    const items = records.filter(record => record.department === department)
    const [hero] = items
    const action = legal ? 'approve_packet' : 'ask_legal'
    const label = legal ? 'Approve factual packet' : 'Ask Legal to verify expense'
    const actions = [{ id: action, label, recipient: legal ? 'Matter file' : 'Legal',
      preview: legal ? 'File both original excerpts. Date unresolved.' : 'Was a second $600 expense authorized?',
      sourceIds: [hero.sources[0].id] }]
    if (legal) actions[0].filing = {title:'Factual packet preview', fields:[{label:'Date confirmation', value:'Unconfirmed'}]}
    const detail = { ...hero, version: 1, sourceVersions: hero.sources.map(s => [s.id, s.version]), actions, receipts: [] }
    if (!legal) {
      detail.reconciliation = { invoiceCents: 900000, stagedCents: 960000, varianceCents: 60000,
        invoiceRows: hero.invoiceRows, stagedRows: hero.stagedRows }
    }
    const turns = [], commands = []
    let identitySubject = department, staleAnswer, staleSource = false
    let markPending, releasePending
    const pending = new Promise(resolve => { markPending = resolve })
    const release = new Promise(resolve => { releasePending = resolve })
    await ctx.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname
      const json = (body, status = 200) => route.fulfill({ status, json: body })
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html style="color-scheme:light dark"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><link rel="stylesheet" href="/claims/assets/workbench.css"><style>html,body,#host{height:100%;margin:0}body{font:14px system-ui}</style><div id="host"></div><script type="module">import {mountWorkbench} from '/claims/assets/workbench.mjs'; mountWorkbench(document.getElementById('host'))</script></html>` })
      if (path.startsWith('/claims/assets/')) {
        const file = path.split('/').at(-1)
        return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url)) })
      }
      if (path === '/auth/me') return json({ user: { principalId: department, subject: identitySubject, tenantId: 'demo', department, displayName: 'Demo reviewer' }, csrfToken: 'test' })
      const base = '/claims/api/departments/' + department
      assert.ok(path.startsWith(base), path)
      if (route.request().method() === 'POST') assert.equal(route.request().headers()['x-csrf-token'], 'test')
      if (path === base + '/records') return json({ items, mail: [], department })
      const selected = base + '/records/' + hero.id
      if (path === selected) return json(detail)
      if (path.startsWith(selected + '/sources/')) {
        assert.equal(new URL(route.request().url()).searchParams.get('version'), '1')
        if (staleSource) return json({message:'Source revision changed.'},409)
        return json(hero.sources.find(source => path.endsWith('/' + source.id)))
      }
      if (path === selected + '/ask') {
        if (route.request().method() === 'GET') return json({ items: turns })
        if (route.request().postDataJSON().question === 'Check again') {
          markPending()
          await release
          return json(staleAnswer)
        }
        const [source] = hero.sources
        const answer = { mode: 'live', model: 'local-test', text: 'Verified evidence excerpt.', sources: [
          { recordId: hero.id, sourceId: source.id, anchorId: source.passages[0].id, title: source.title, version: source.version },
        ] }
        staleAnswer = { ...answer, text: 'An earlier inventory was checked.' }
        turns.push({ question: route.request().postDataJSON().question, answer })
        return json(answer)
      }
      if (path === selected + '/actions/' + action) {
        commands.push(route.request().postDataJSON())
        detail.version++
        detail.actions = []
        detail.receipts = [{ id: 'R-123', summary: 'Approved', at: hero.dueAt, destination: {
          id: 'MOCK-017', system: 'Matter file', title: 'Review', at: hero.dueAt,
          fields: [{label:'Status',value:'Reviewed'}],sources:[{id:hero.sources[0].id,version:1}],
        } }]
        return json(detail)
      }
      return json({}, 404)
    })
    await page.goto('http://localhost/?mode=workbench')
    await page.getByRole('button', { name: 'Open ' + hero.id + ' ' + hero.title }).click()
    const pane = page.getByRole('article', { name: 'Selected record' })
    if (legal) {
      await pane.getByText('Incident date in supervisor report').waitFor()
      await pane.getByText('Shift handover recorded on file').waitFor()
      await pane.getByRole('button', { name: 'Supervisor incident report', exact: true }).first().click()
      await page.locator('dialog .dp-marked').getByText(/November 9/).waitFor()
      await page.keyboard.press('Escape')
    } else {
      await pane.getByRole('button', { name: 'Highlight variance +$600.00' }).click()
      assert.equal(await pane.locator('tr.dp-highlight').count(), 3)
      await pane.getByRole('button', { name: 'Additional expense line' }).click()
      await page.locator('dialog .dp-marked').getByText('EXP-044 · $600.00').waitFor()
      await page.getByRole('button', { name: 'Close', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Ask agent' }).click()
    const chat = page.getByRole('complementary', { name: 'Department agent' })
    await chat.getByRole('textbox').fill(legal ? 'Verify the dates' : 'Explain the variance')
    await chat.getByRole('button', { name: 'Send', exact: true }).click()
    await chat.getByText('Verified evidence excerpt.').waitFor()
    await chat.getByRole('button', { name: hero.sources[0].title }).click()
    await page.locator('dialog .dp-marked').waitFor()
    const pdf = page.getByRole('link', { name: 'Open PDF' })
    assert.ok((await pdf.getAttribute('href')).endsWith('?version=1&format=pdf#nameddest=' + hero.sources[0].passages[0].id))
    assert.match(await pdf.getAttribute('rel'), /noopener/)
    await page.keyboard.press('Escape')
    await chat.getByRole('textbox').fill('Check again')
    await chat.getByRole('button', { name: 'Send', exact: true }).click()
    await pending
    detail.sourceVersions[0][1]++
    turns.length = 0
    const refreshed = page.waitForResponse(r => r.url().endsWith('/ask') && r.request().method() === 'GET')
    await page.getByRole('button', {name:'Refresh',exact:true}).click()
    await refreshed
    await chat.getByText('Verified evidence excerpt.').waitFor({state:'detached'})
    const stale = page.waitForResponse(r => r.url().endsWith('/ask') && r.request().method() === 'POST')
    releasePending()
    await stale
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await chat.getByText('An earlier inventory was checked.').count(),0)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await pane.isVisible(), false)
    assert.equal(await chat.getByRole('textbox').isVisible(), true)
    await chat.getByRole('button', { name: 'Collapse' }).click()
    await pane.getByRole('button', { name: label, exact: true }).click()
    if (legal) {
      await page.getByRole('dialog').getByText('Factual packet preview').waitFor()
      await page.getByRole('dialog').getByText(/Date confirmation · Unconfirmed/).waitFor()
    }
    await page.getByRole('button', { name: 'Cancel' }).click()
    assert.equal(commands.length, 0)
    await pane.getByRole('button', { name: label, exact: true }).click()
    await page.getByRole('button', { name: 'Confirm ' + label.toLowerCase() }).click()
    await pane.getByText(/R-123/).waitFor()
    await page.getByText('View destination record').click()
    await pane.getByText(/MOCK-017/).waitFor()
    await pane.getByRole('button', {name: hero.sources[0].title + ' · v1', exact: true}).click()
    await page.getByRole('dialog').getByRole('heading', {name:hero.sources[0].title}).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(commands.length, 1)
    assert.equal(commands[0].expectedVersion, 1)
    assert.ok(commands[0].requestId)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    staleSource = true
    await pane.getByRole('button', {name:hero.sources[0].title,exact:true}).first().click()
    await page.getByRole('alert').filter({hasText:'Source revision changed.'}).waitFor()
    assert.equal(await page.getByRole('dialog').count(),0)
    identitySubject = 'someone-else'
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Your session no longer has access to this portfolio.').waitFor()
    assert.equal(await pane.count(), 0)
    await ctx.close()
  }
  assert.deepEqual(errors, [])
  console.log('PASS both department queues, source anchors, scoped chat, mobile layout, approvals and session changes')
} finally {
  await browser.close()
}
