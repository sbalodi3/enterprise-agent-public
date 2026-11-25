// Drives the synthetic Compose story over the same authenticated API as the
// native panel. This creates one wage review and simulated receipt in WC-102.
import { pickEmployee } from '../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')
const origin = 'http://localhost:3080'
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
try {
  const page = await browser.newPage()
  await page.goto(origin + '/open-workbench')
  await pickEmployee(page, 'maya')
  await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor()
  const csrf = (await (await page.request.get(origin + '/auth/me')).json()).csrfToken
  async function api(path, data, status = 200) {
    const url = origin + '/claims/api/' + path
    const response =
      data === undefined
        ? await page.request.get(url)
        : await page.request.post(url, { data, headers: { origin, 'x-csrf-token': csrf } })
    const result = await response.json()
    assert.equal(response.status(), status, path + ' returned ' + (result.code ?? response.status()))
    return { data: result, traceId: response.headers()['x-claims-trace-id'] }
  }
  async function eventually(fn) {
    const end = Date.now() + 60000
    do {
      const value = await fn()
      if (value) return value
      await delay(500)
    } while (Date.now() < end)
    throw new Error('Timed out waiting for the domain state to advance')
  }
  const detail = () => api('items/WC-102').then((r) => r.data)
  assert.equal((await api('status')).data.workflow, true, 'Start the story profile')
  const requestId = 'smoke-' + randomUUID()
  const event = { requestId, eventId: 'callback-' + requestId, fixtureId: 'a2a-update' }
  await api('fixtures', event, 404)
  const start = await api('wages', {
    requestId,
    itemId: 'WC-102',
    expectedVersion: (await detail()).item.version,
  })
  await api('fixtures', event)
  assert.equal((await api('fixtures', event)).data.duplicate, true)
  const proposal = await eventually(async () =>
    (await detail()).proposals.find((x) => x.requestId === requestId && x.status === 'pending'),
  )
  assert.ok(proposal.digest)
  assert.equal((await detail()).wages.find((w) => w.requestId === requestId).operationId, null)
  await page.getByRole('button', { name: 'Open WC-102 Wage evidence request' }).click()
  await page.getByRole('button', { name: 'Reviews', exact: true }).click()
  await page
    .getByText('Digest ' + proposal.digest, { exact: true })
    .first()
    .waitFor()
  await page.getByRole('button', { name: 'Demo controls', exact: true }).click()
  await page.getByLabel('Lose next approval acknowledgement').check()
  const approvalResponse = page.waitForResponse((r) =>
    r.url().endsWith('/proposals/' + proposal.id + '/review'),
  )
  const article = page
    .locator('article.cw-entry')
    .filter({ hasText: proposal.digest })
    .filter({ has: page.getByRole('button', { name: 'Approve exact proposal' }) })
  await article.getByRole('button', { name: 'Approve exact proposal' }).click()
  const approval = await approvalResponse
  assert.equal(approval.status(), 200)
  const { operationId } = await approval.json()
  const operation = () => api('operations/' + operationId).then((r) => r.data)
  await eventually(async () => (await operation()).state === 'unknown')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  const unknown = page.locator('article.cw-entry').filter({ hasText: operationId })
  await unknown.getByText('unknown', { exact: true }).waitFor()
  await unknown.getByRole('button', { name: 'Reconcile receipt' }).click()
  const confirmed = await eventually(async () => {
    const op = await operation()
    return op.state === 'confirmed' && op
  })
  assert.ok(confirmed.receiptId.startsWith('fixture-'))
  const final = await detail()
  assert.equal(final.wages.find((w) => w.requestId === requestId).state, 'confirmed')
  assert.equal(final.proposals.filter((p) => p.requestId === requestId).length, 1)
  const approvalTrace = approval.headers()['x-claims-trace-id']
  if (process.argv.includes('--observe')) {
    assert.match(approvalTrace, /^[a-f0-9]{32}$/)
    await eventually(async () => {
      const res = await fetch('http://localhost:16686/api/traces/' + approvalTrace)
      if (!res.ok) return false
      const trace = await res.json()
      return trace.data?.some((t) =>
        t.spans.some(
          (s) =>
            s.operationName === 'claims.proposals' && s.references.some((r) => r.traceID === start.traceId),
        ),
      )
    })
    await eventually(async () => {
      const query = new URLSearchParams({
        'query.serviceName': 'claims-workbench',
        'query.operationName': 'claims.worker.reconcileOperation',
        'query.startTimeMin': new Date(Date.now() - 300000).toISOString(),
        'query.startTimeMax': new Date().toISOString(),
        'query.searchDepth': '40',
      })
      const res = await fetch('http://localhost:16686/api/v3/traces?' + query)
      if (!res.ok) return false
      const envelopes = (await res.text())
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      return envelopes.some((e) =>
        e.result?.resourceSpans?.some((r) =>
          r.scopeSpans.some((scope) =>
            scope.spans.some(
              (span) =>
                span.name === 'claims.worker.reconcileOperation' &&
                span.links?.some((link) => link.traceId === approvalTrace),
            ),
          ),
        ),
      )
    })
    console.log('Verified the wage admission, review and receipt lookup are linked in Jaeger.')
  }
  console.log(
    'Verified out-of-order and duplicate callbacks, approval, lost acknowledgement and one confirmed workflow receipt.',
  )
} finally {
  await browser.close()
}
