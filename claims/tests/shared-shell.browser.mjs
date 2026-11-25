// Both modes use the real employee gateway. Optional --turn requires configured local inference.
import { pickEmployee } from '../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')
const app = new URL(process.env.CLAIMS_APP_ORIGIN || 'http://localhost:3080')
assert.ok(app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname))
const browser = await chromium.launch({ channel: 'chrome' })
const button = (root, name) => root.getByRole('button', { name, exact: true })
async function signIn(page, employee) {
  for (const [name, action] of [['Preview Notice', 'Continue'], ['Add an API key to get started', 'Configure later']]) {
    const dialog = page.getByRole('dialog', { name })
    await page.addLocatorHandler(dialog, () => button(dialog, action).click())
  }
  await page.goto(new URL('/open-app', app).href)
  await pickEmployee(page, employee)
}
try {
  const modes = process.argv.includes('--portfolio-only') ? [] : process.argv.includes('--shared') ? ['shared'] : ['hosted', 'workstation']
  for (const mode of modes) {
    const context = await browser.newContext({ reducedMotion: 'reduce',
      colorScheme: mode === 'hosted' ? 'light' : 'dark',
      viewport: mode === 'hosted' ? { width: 1280, height: 800 } : { width: 536, height: 680 },
    })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(20000)
      const mac = new URL(app)
      mac.port = String(Number(app.port) + 1)
      if (mode !== 'workstation') await page.route(mac.origin + '/desktop/presence', route => route.abort())
      await signIn(page, 'maya')
      const expectedPort = mode === 'shared' ? app.port : mode === 'hosted' ? String(Number(process.env.CLAIMS_CHAT_PORT_BASE || 3083)) : mac.port
      await page.waitForURL(url => url.port === expectedPort && (mode !== 'shared' || url.pathname === '/chat'))
      const composer = page.locator('[data-composer-card]:visible')
      const editor = composer.locator('[contenteditable=true]').first()
      await button(composer, 'Choose scope').waitFor()
      const node = await editor.elementHandle()
      const session = await editor.evaluate(el => el.closest('[data-conversation-session]').dataset.conversationSession)
      const title = 'shell-round-trip.txt'
      const draft = 'Continue reviewing my notes'
      if (process.env.CHAT_TEST_DIAGNOSTICS) page.on('response',async response => {
        if(response.url().includes('uploadFile') || response.status()>=400)
          console.error('Chat response',response.status(),new URL(response.url()).pathname)
      })
      await composer.locator('input[type=file]').setInputFiles({ name: title, mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') })
      try { await composer.getByText(title, { exact: true }).first().waitFor() }
      catch(error) { console.error('Composer state',await composer.innerText());throw error }
      await editor.fill(draft)
      let documents = 0, sockets = 0
      page.on('request', req => { if (req.isNavigationRequest() && req.frame() === page.mainFrame()) documents++ })
      page.on('websocket', () => { sockets++ })
      const sidebar = page.locator('[data-sidebar-opener]:visible')
      const openSidebar = async () => { if (await sidebar.count()) await sidebar.first().click() }
      const selectSidebar = async name => {
        const action = button(page, name)
        if (!(await action.isVisible())) await openSidebar()
        await action.click()
      }
      const openWorkbench = () => selectSidebar('Workbench')
      const returnToChat = async () => {
        await selectSidebar('Return to chat')
        await editor.waitFor()
      }
      await page.route('**/claims/assets/workbench-panel.mjs', route => route.abort(), { times: 1 })
      await openWorkbench()
      await button(page, 'Open standalone Workbench').waitFor()
      await button(page, 'Retry').click()
      const record = page.getByRole('button', { name: /^Open WC-101\b/ })
      await record.click()
      const ask = button(page, 'Ask agent')
      await ask.waitFor()
      assert.equal(await button(page, 'Agent Chat').count(), 0)
      const bounds = await ask.boundingBox()
      const workArea = await page.locator('.cw-work-area').boundingBox()
      assert.equal(workArea.x + workArea.width - (bounds.x + bounds.width), 20)
      assert.equal(workArea.y + workArea.height - (bounds.y + bounds.height), 20)
      await ask.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      assert.equal(await ask.evaluate(el => el.matches(':focus-visible')), true)
      if (process.env.CLAIMS_SHELL_SCREENSHOTS) {
        await page.screenshot({ path: process.env.CLAIMS_SHELL_SCREENSHOTS + '/' + mode + '.png' })
      }
      assert.equal(await button(page, 'Chat').count(), 0)
      assert.equal(await button(page, 'Work modes').count(), 0)
      await button(page, 'Evidence & timeline').click()
      const connected = await page.getByRole('button', { name: 'Callback diary', exact: true }).count() > 0
      const sourceName = connected ? 'Callback diary' : 'Source note · Diary'
      await button(page, sourceName).click()
      const source = connected ? page.locator('.cw-paper') : page.getByText('Synthetic source. Callback deadline this shift', { exact: true })
      await source.waitFor()
      if (connected) {
        await page.getByRole('link', { name: 'Open PDF' }).click()
        await page.frameLocator('iframe[title="Claim PDF viewer"]').locator('#download:enabled').waitFor()
        await button(page, 'Close PDF').click()
      }
      await returnToChat()
      assert.equal(await editor.innerText(), draft)
      assert.ok(await node.evaluate(el => el.isConnected && el.closest('[data-conversation-session]').dataset.conversationSession !== undefined))
      assert.equal(await editor.evaluate(el => el.closest('[data-conversation-session]').dataset.conversationSession), session)
      await composer.getByText(title, { exact: true }).first().waitFor()
      await page.goBack()
      await page.getByRole('navigation', { name: 'Record views' }).waitFor()
      assert.equal(await button(page, 'Evidence & timeline').getAttribute('aria-current'), 'page')
      await source.waitFor()
      await page.goForward()
      await editor.waitFor()
      assert.equal(await editor.innerText(), draft)
      assert.equal(documents, 0)
      assert.equal(sockets, 0)
      console.log('PASS', mode, 'same document, connection, composer, attachment, draft, session, record tab and browser history')
      if (connected) {
        await openWorkbench()
        await button(page, 'Ask agent').click()
        await button(page, 'Open in Chat').click()
        await editor.waitFor()
        await button(composer, 'Remove WC-101').waitFor()
        const protectedId = new URL(page.url()).searchParams.get('conversation')
        assert.ok(protectedId)
        await openWorkbench()
        await button(page, 'Ask agent').click()
        await button(page, 'Open in Chat').click()
        await editor.waitFor()
        assert.equal(new URL(page.url()).searchParams.get('conversation'), protectedId)
        assert.equal(documents, 0)
        console.log('PASS', mode, 'protected PDF and drawer conversation binding')
      }
      // Simulate a record reassignment between visits. The restored view must reauthorize.
      await page.route('**/claims/api/items/WC-101', route => route.fulfill({ status: 404, json: { code: 'not_found' } }), { times: 1 })
      await openWorkbench()
      await page.getByText('This record is no longer available.', { exact: true }).waitFor()
      assert.equal(await page.locator('.cw-paper:visible').count(), 0)
      await returnToChat()
      if (process.argv.includes('--turn')) {
        // An explicit claim handoff creates a separate native session and leaves the original draft alone.
        await openWorkbench()
        await record.click()
        await ask.click()
        await button(page, 'Open in Chat').click()
        await button(composer, 'Remove WC-101').waitFor()
        const id = new URL(page.url()).searchParams.get('conversation')
        assert.ok(id)
        const question = 'Summarize the evidence for the callback deadline.'
        const turnPath = '/claims/api/chat/turn/' + id
        let submissions = 0
        page.on('request', req => { if (new URL(req.url()).pathname === turnPath && req.method() === 'POST') submissions++ })
        const accepted = page.waitForResponse(r => new URL(r.url()).pathname === turnPath && r.request().method() === 'POST')
        await editor.fill(question)
        await editor.press('Enter')
        assert.ok((await accepted).ok())
        await openWorkbench()
        await record.waitFor()
        await returnToChat()
        const completed = page.locator('.cs-transcript:visible article:is([data-turn-state=completed],[data-turn-state=failed])').filter({ hasText: question })
        await completed.waitFor({ timeout: 170000 })
        assert.equal(await completed.getAttribute('data-turn-state'), 'completed')
        assert.ok((await completed.locator('.cc-answer').innerText()).trim())
        assert.equal(await completed.count(), 1)
        assert.equal(submissions, 1)
        assert.equal(documents, 0)
        assert.equal(sockets, 0)
        console.log('PASS', mode, 'one admitted live turn and one completed answer across the switch')
      }
      await selectSidebar('Sign out')
      await page.getByRole('heading', { name: 'You are signed out' }).waitFor()
    } finally { await context.close() }
  }
  if (process.argv.includes('--portfolio') || process.argv.includes('--portfolio-only')) {
    for (const employee of ['maya', 'alex']) {
      const context = await browser.newContext({ colorScheme: employee === 'maya' ? 'light' : 'dark',
        viewport: employee === 'maya' ? { width: 1280, height: 800 } : { width: 520, height: 740 } })
      try {
        const page = await context.newPage()
        const mac = new URL(app)
        mac.port = String(Number(app.port) + 1)
        if (employee !== 'maya' || !process.argv.includes('--workstation-cards')) await page.route(mac.origin + '/desktop/presence', route => route.abort())
        await signIn(page, employee)
        const composer = page.locator('[data-composer-card]:visible')
        await button(composer, 'Choose scope').waitFor()
        const open = '/claims/api/chat/search?status=open&limit=50'
        const { items } = await page.evaluate(path => fetch(path).then(r => r.json()), open)
        const expected = items.filter(item => item.ownerId === employee).map(item => item.id)
        assert.ok(expected.length)
        const editor = composer.locator('[contenteditable=true]').first()
        await editor.fill('What are my open cases?')
        await editor.press('Enter')
        const settled = page.locator('.cs-transcript:visible article:is([data-turn-state=completed],[data-turn-state=failed])').last()
        await settled.waitFor({ timeout: 170000 })
        assert.equal(await settled.getAttribute('data-turn-state'), 'completed')
        const card = settled.frameLocator('iframe[title="Interactive case list"]').frameLocator('iframe[title="Widget content"]')
        const first = expected[0]
        const rows = card.getByRole('button')
        await rows.first().waitFor()
        assert.deepEqual(await rows.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label').split(' ')[1])), expected.slice(0, 12))
        assert.equal(await card.locator('#count').innerText(), expected.length + (expected.length === 1 ? ' case' : ' cases'))
        const conversation = new URL(page.url()).searchParams.get('conversation')
        const node = await editor.elementHandle()
        let navigations = 0
        page.on('request', req => { if (req.isNavigationRequest() && req.frame() === page.mainFrame()) navigations++ })
        if (process.env.CLAIMS_SHELL_SCREENSHOTS) {
          await settled.locator('iframe').screenshot({ path: process.env.CLAIMS_SHELL_SCREENSHOTS + '/case-card-' + employee + '.png' })
        }
        assert.equal(await card.locator('body').evaluate(el => el.scrollWidth <= el.clientWidth), true)
        await editor.fill('My follow-up draft')
        await rows.first().focus()
        await rows.first().press('Enter')
        await page.locator('.cw-detail .cw-id').filter({ hasText: first }).waitFor()
        await page.locator('.cw-status[role=status]').waitFor()
        const refreshed = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/conversation/' + conversation))
        await button(page, 'Refresh').click()
        const updated = await (await refreshed).json()
        assert.equal(updated.turns.at(-1).cases.total, expected.length)
        const back = button(page, 'Return to chat')
        if (!(await back.isVisible())) await page.locator('[data-sidebar-opener]:visible').first().click()
        await back.click()
        await rows.first().waitFor()
        assert.equal(await editor.innerText(), 'My follow-up draft')
        assert.equal(await node.evaluate(el => el.isConnected), true)
        assert.equal(new URL(page.url()).searchParams.get('conversation'), conversation)
        assert.equal(navigations, 0)
        console.log('PASS', employee, 'verified card rows, keyboard case opening, refresh, and return to the same composer')
      } finally { await context.close() }
    }
  }
} finally { await browser.close() }
