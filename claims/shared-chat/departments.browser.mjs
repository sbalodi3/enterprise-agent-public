// Exercise three independent browser logins against one connected Podman project.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pickEmployee } from '../auth/tests/picker.mjs'

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(
  process.env.CLAIMS_TEST_PLAYWRIGHT || 'playwright',
)
const origin = new URL(process.env.CLAIMS_TEST_ORIGIN || 'http://127.0.0.1:3280').origin
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const profiles = [
  { employee: 'maya', record: 'WC-101' },
  {
    employee: 'finance',
    record: 'FIN-207',
    question: 'What explains the $600 billing variance?',
    source: 'INV-318',
    citation: /600/,
    action: 'open_review',
  },
  {
    employee: 'legal',
    record: 'MAT-017',
    question: 'Prepare the incident chronology and explain the conflicting dates.',
    source: 'WC-103-report',
    citation: /November/,
    action: 'approve_packet',
  },
]
const signedIn = []
async function rpc(page, method, args) {
  const response = await page.request.post(origin + '/api/' + method, {
    headers: { origin },
    data: {
      type: 'client-request',
      method,
      rpcId: randomUUID(),
      payload: { args },
    },
  })
  return (await response.json()).result
}
async function checkMailbox({ page, employee, post, get, id }) {
  const list = async () =>
    (await (await get('/claims/api/connections')).json()).apps.find((app) => app.id === 'outlook-mail')
  const initial = await list()
  assert.equal(initial.mode, 'local')
  assert.equal(initial.available, true)
  if (process.argv.includes('--require-connected')) assert.equal(initial.status, 'connected')
  async function consent(account, expected) {
    const response = await post('/claims/api/connections/outlook-mail/connect', {})
    assert.equal(response.status(), 200)
    const url = new URL((await response.json()).url)
    assert.equal(url.origin, process.env.CLAIMS_TEST_OUTLOOK_ORIGIN || 'http://127.0.0.1:8381')
    const picker = await page.context().newPage()
    try {
      await picker.goto(url.href)
      const callback = picker.waitForResponse(
        (r) => new URL(r.url()).pathname === '/claims/connections/microsoft/callback',
      )
      await picker
        .getByRole('button')
        .filter({ hasText: account + '@example.test' })
        .click({ noWaitAfter: true })
      assert.equal((await callback).status(), expected)
    } finally {
      await picker.close()
    }
  }
  if (initial.status !== 'connected') {
    await consent(employee === 'finance' ? 'legal' : 'finance', 403)
    await consent(employee, 200)
  }
  assert.equal((await list()).address, employee + '@example.test')
  await page.goto(origin + '/chat?session=' + id)
  const question = 'Search my Outlook email for Westfield invoice.'
  const reply = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/claims/api/mail-chat/'),
    { timeout: 150000 },
  )
  const editor = page.locator('[data-composer-input][contenteditable=true]:visible').first()
  await page.getByRole('button', { name: 'Outlook Mail', exact: true }).click()
  await editor.fill(question)
  await editor.press('Enter')
  const response = await reply
  assert.equal(response.status(), 200, await response.text())
  const { turn } = await response.json()
  assert.ok(turn.answer.items.some((item) => item.subject === 'Westfield invoice'))
  console.log('Verified delegated Outlook consent and search inside Chat for', employee)
}
try {
  for (const profile of profiles) {
    const { employee } = profile
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    page.on('pageerror', (err) => console.error(employee, err.message))
    await page.goto(origin + '/open-app')
    await pickEmployee(page, employee)
    await page.waitForURL((url) => url.origin === origin && url.pathname === '/chat')
    for (const [title, action] of [
      ['Preview Notice', 'Continue'],
      ['Add an API key to get started', 'Configure later'],
    ]) {
      const dialog = page.getByRole('dialog', { name: title })
      await page.addLocatorHandler(dialog, () => dialog.getByRole('button', { name: action, exact: true }).click())
    }
    const editor = page.locator('[data-composer-input][contenteditable=true]:visible').first()
    await editor.waitFor()
    const id = await editor.evaluate((el) => el.closest('[data-conversation-session]').dataset.conversationSession)
    const get = (path) => page.request.get(origin + path)
    const me = await (await get('/auth/me')).json()
    const config = await (await get('/claims/api/chat/bootstrap')).json()
    assert.equal(config.subject, me.user.subject)
    assert.equal(config.department, employee === 'maya' ? undefined : employee)
    const post = (path, data) =>
      page.request.post(origin + path, { data, headers: { origin, 'x-csrf-token': me.csrfToken } })
    const base = '/claims/api/departments/' + employee
    const chat = base + '/chat/' + id
    if (employee === 'maya') {
      assert.equal((await get('/claims/api/items/' + profile.record)).status(), 200)
      assert.equal(await page.getByLabel('Department record').count(), 0)
      await page.getByRole('button', { name: 'Choose scope', exact: true }).click()
      const scopePicker = page.getByRole('dialog', { name: 'Choose scope' })
      await scopePicker.getByRole('button', { name: 'Documents for WC-101' }).waitFor()
      assert.equal(await scopePicker.getByRole('button', { name: 'Documents for MAT-017' }).count(), 0)
      await page.keyboard.press('Escape')
    } else {
      const select = page.getByRole('combobox', { name: 'Department record' })
      await select.selectOption(profile.record)
      await page.waitForFunction(
        (record) => document.querySelector('[aria-label="Department record"]')?.value === record,
        profile.record,
      )
      const ask = page.waitForResponse(
        (r) => r.url() === origin + chat + '/ask' && r.request().method() === 'POST',
        { timeout: 110000 },
      )
      await editor.fill(profile.question)
      await editor.press('Enter')
      const response = await ask
      assert.equal(response.status(), 200, await response.text())
      await page.getByText(profile.question, { exact: true }).first().waitFor()
      const own = await (await get(chat)).json()
      const action = own.actions.find((action) => action.id === profile.action)
      assert.ok(action)
      await page.getByRole('button', { name: action.label, exact: true }).click()
      const review = page.getByRole('region', { name: 'Review action' })
      await review.getByRole('button', { name: 'Confirm ' + action.label, exact: true }).waitFor()
      await review.getByRole('button', { name: 'Cancel' }).click()
      assert.equal((await (await get(chat)).json()).version, own.version)
      assert.ok(
        own.turns.some(
          (t) =>
            t.question === profile.question && profile.citation.test(t.answer.text) && t.answer.sources.length,
        ),
      )
      const pdf = await get(base + '/records/' + profile.record + '/sources/' + profile.source + '?format=pdf')
      assert.equal(pdf.status(), 200)
      assert.equal((await pdf.body()).subarray(0, 4).toString(), '%PDF')
      assert.equal((await get('/chat/files')).status(), 403)
      const nativePrompt = await rpc(page, 'session/prompt', {
        request: {
          sessionId: id,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text: 'Test access' }],
        },
      })
      assert.equal(nativePrompt.error?.code, 'remote-access/denied')
      const linked = await page.context().newPage()
      await linked.goto(origin + '/chat?session=' + id)
      await linked.getByText(profile.question, { exact: true }).first().waitFor()
      await linked.getByRole('button', { name: 'Workbench', exact: true }).click()
      await linked.getByRole('button', { name: new RegExp('^Open ' + profile.record) }).click()
      await linked.getByRole('button', { name: 'Ask agent', exact: true }).click()
      await linked.waitForFunction(
        (record) => document.querySelector('[aria-label="Department record"]')?.value === record,
        profile.record,
      )
      assert.equal(new URL(linked.url()).pathname, '/chat')
      await linked.goto(origin + '/open-workbench')
      await linked.getByRole('button', { name: new RegExp('^Open ' + profile.record) }).click()
      await linked.getByRole('button', { name: 'Ask agent', exact: true }).click()
      await linked.waitForURL((url) => url.pathname === '/chat' && url.searchParams.has('session'))
      assert.equal(await linked.getByLabel('Department record').inputValue(), profile.record)
      await linked.close()
      // An identical retried turn is durable once. A changed use of the same request ID is rejected.
      const retry = await response.request().postDataJSON()
      assert.equal((await post(chat + '/ask', retry)).status(), 200)
      assert.equal((await post(chat + '/ask', { ...retry, question: 'A different question' })).status(), 409)
      assert.equal((await (await get(chat)).json()).turns.length, own.turns.length)
      assert.equal((await post(chat + '/scope', { previous: null, recordId: null })).status(), 409)
    }
    const employeeSession = { ...profile, page, id, get, post, chat, base }
    if (process.argv.includes('--outlook')) await checkMailbox(employeeSession)
    signedIn.push(employeeSession)
    console.log('Verified sign-in, composer and assigned data for', employee)
  }
  for (const user of signedIn)
    for (const other of signedIn.filter((row) => row !== user)) {
      const target = '/claims/api/departments/' + other.employee
      const record =
        other.employee === 'maya' ? '/claims/api/items/' + other.record : target + '/records/' + other.record
      assert.equal((await user.get(record)).status(), 404)
      assert.equal((await user.get('/claims/api/mail-chat/' + other.id)).status(), 404)
      assert.equal((await user.get('/chat?session=' + other.id)).status(), 404)
      assert.equal(
        (await rpc(user.page, 'session/state', { request: { sessionId: other.id } })).error?.code,
        'remote-access/denied',
      )
      if (other.employee !== 'maya') {
        assert.equal((await user.get('/chat?record=' + other.record)).status(), 404)
        assert.equal((await user.get(other.chat)).status(), 404)
        assert.equal((await user.get(record + '/sources/' + other.source + '?format=pdf')).status(), 404)
        assert.equal(
          (
            await user.post(record + '/actions/' + other.action, { requestId: randomUUID(), expectedVersion: 1 })
          ).status(),
          404,
        )
      }
      if (user.employee !== 'maya') {
        assert.equal((await user.get(user.base + '/chat/' + other.id)).status(), 404)
        assert.equal(
          (await user.post(user.chat + '/scope', { recordId: other.record, previous: user.record })).status(),
          404,
        )
        assert.equal(
          (
            await user.post(user.chat + '/ask', {
              question: 'Show the other record',
              recordId: other.record,
              requestId: randomUUID(),
            })
          ).status(),
          409,
        )
      }
    }
  console.log('Passed all six cross-department access directions.')
} finally {
  await browser.close()
}
