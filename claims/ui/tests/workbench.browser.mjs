// Runs the production panel against a synthetic HTTP contract with no external requests.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1050, height: 900 }, colorScheme: 'light' })
const item = {
  id: 'WC-101',
  type: 'claim',
  title: 'Promised callback',
  ownerId: 'maya',
  version: 1,
  section: 'must',
  reason: 'A promised callback is due',
  nextAction: 'Prepare callback',
  dueAt: '2026-11-17T15:00:00Z',
  asOf: '2026-11-17T14:00:00Z',
  source: 'Diary',
}
const source = { id: 'note-1', title: 'Diary note', source: 'Diary', asOf: item.asOf }
const details = {
  item,
  timeline: [{ ...source, at: source.asOf, summary: 'Assigned to examiner' }],
  evidence: [source],
  proposals: [],
  operations: [],
  wages: [],
  canAct: true,
}
const failed = [],
  writes = []
let activePrincipal = 'maya'
let workflowAvailable = false
page.on('pageerror', (err) => failed.push(err.message))
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url()),
    path = url.pathname
  assert.equal(url.hostname, 'workbench.test')
  const respond = (body, status = 200) => route.fulfill({ status, json: body })
  if (path === '/')
    return route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html style="color-scheme:light dark"><head><link rel="stylesheet" href="/workbench.css"><style>html,body{height:100%;margin:0}main{height:100%}body{font:14px Arial,sans-serif}</style></head><body><main></main><script type="module">import {mountWorkbench} from '/workbench.mjs';mountWorkbench(document.querySelector('main'))</script></body></html>`,
    })
  if (['/workbench.mjs', '/workbench.css', '/showcase.mjs', '/action-review.mjs', '/timeline-host.mjs', '/widget-format.mjs', '/pdf-link.mjs'].includes(path))
    return route.fulfill({
      contentType: path.endsWith('css') ? 'text/css' : 'text/javascript',
      body: await readFile(new URL('..' + path, import.meta.url), 'utf8'),
    })
  if (path === '/auth/me')
    return respond({
      user: {
        principalId: activePrincipal,
        subject: activePrincipal,
        tenantId: 'demo',
        displayName: activePrincipal,
        roles: ['adjuster'],
      },
      csrfToken: 'localtest',
    })
  if (route.request().method() === 'POST') {
    assert.equal(route.request().headers()['x-csrf-token'], 'localtest')
    writes.push([path, route.request().postDataJSON()])
  }
  if (path === '/auth/logout') return respond({ ok: true })
  if (path === '/auth/signed-out')
    return route.fulfill({ contentType: 'text/html', body: '<h1>Signed out</h1>' })
  if (path.endsWith('/items/WC-101/sessions'))
    return respond({ items: [{ sessionId: 's1', mode: 'replay', task: 'timeline', createdAt: item.asOf }] })
  if (path.endsWith('/sessions/s1'))
    return respond({ text: 'Previous case session', mode: 'replay', sources: [] })
  if (path.endsWith('/portfolio')) return respond({ items: [item], counts: { must: 1 }, decisionSetId: 'd1' })
  if (path.endsWith('/mailbox')) return respond({ items: [] })
  if (path.endsWith('/status')) return respond({ workflow: workflowAvailable })
  if (path.endsWith('/items/' + item.id)) return respond(details)
  if (path.endsWith('/evidence/note-1')) return respond({ ...source, body: 'Synthetic supporting evidence.' })
  if (path.endsWith('/assist'))
    return respond({ mode: 'replay', text: 'A callback is due this shift.', sources: [source] })
  if (path.endsWith('/feedback') || path.endsWith('/exposure')) return respond({ ok: true })
  if (path.endsWith('/prepare')) {
    details.proposals = [
      { id: 'p1', action: 'record-review', digest: 'abc123', status: 'pending', version: 1 },
    ]
    return respond(details.proposals[0])
  }
  if (path.endsWith('/p1/review')) {
    details.proposals[0].status = 'approved'
    return respond({ status: 'approved' })
  }
  return respond({ message: 'Unsupported test request' }, 400)
})
try {
  await page.goto('http://workbench.test/')
  await page.getByRole('button', { name: 'Open WC-101 Promised callback' }).click()
  await page.getByRole('button', { name: 'Run assistant' }).click()
  await page.getByText('A callback is due this shift.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Diary note', exact: true }).click()
  await page.getByText('Synthetic supporting evidence.').waitFor()
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click()
  await page.getByRole('button', { name: 'Approve exact proposal' }).click()
  await page.getByText('Version 1 · approved').waitFor()
  await page.getByRole('button', { name: 'People', exact: true }).click()
  await page.getByRole('button', { name: 'Send work request' }).click()
  await page.getByRole('alert').getByText('Enter a request for your colleague.').waitFor()
  await page.getByRole('button', { name: 'Inbox', exact: true }).click()
  await page.getByText('No messages in your mailbox.').waitFor()
  await page.getByRole('button', { name: 'My portfolio' }).click()
  await page.getByRole('checkbox', { name: 'Select WC-101 for handoff' }).check()
  await page.getByRole('button', { name: 'Prepare handoffs' }).click()
  await page.getByRole('heading', { name: 'Prepared handoffs' }).waitFor()
  for (const [width, theme] of [
    [1050, 'light'],
    [380, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.getByRole('button', { name: 'Open WC-101 Promised callback' }).click()
    await page.getByRole('button', { name: 'Overview', exact: true }).click()
    assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth))
    if (process.env.CLAIMS_UI_SCREENSHOTS)
      await page.screenshot({ path: process.env.CLAIMS_UI_SCREENSHOTS + '/workbench-' + width + '.png' })
  }
  await page.goto('http://workbench.test/')
  await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Run assistant' }).count(), 0)
  await page.getByRole('button', { name: 'Open WC-101 Promised callback' }).click()
  assert.equal(
    await page.getByRole('button', { name: 'Overview', exact: true }).getAttribute('aria-current'),
    'page',
  )
  await page.getByRole('button', { name: 'Previous sessions' }).click()
  await page.getByRole('button', { name: /Summarize timeline · replay/ }).click()
  await page.getByText('Previous case session', { exact: true }).waitFor()
  activePrincipal = 'alex'
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByText('alex', { exact: true }).waitFor()
  await page
    .getByText('Open a work item to review its evidence, timeline and next action.')
    .waitFor({ state: 'attached' })
  assert.equal(await page.getByText('Previous case session', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Run assistant' }).count(), 0)
  item.id = 'WC-102'
  await page.goto('http://workbench.test/')
  await page.getByRole('button', { name: 'Open WC-102 Promised callback' }).click()
  await page.getByText('Start the local Story profile to run or resume a partner wage request.').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Request wage evidence' }).count(), 0)
  workflowAvailable = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('button', { name: 'Request wage evidence' }).waitFor()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('heading', { name: 'Signed out' }).waitFor()
  assert.deepEqual(failed, [])
  assert.ok(writes.some(([p]) => p.endsWith('/exposure')))
  assert.ok(writes.some(([p, b]) => p.endsWith('/p1/review') && b.expectedVersion === 1))
  console.log(
    'Workbench panel passed portfolio, evidence, replay, review, validation, mailbox, bulk handoff and layout checks.',
  )
} finally {
  await browser.close()
}
