// Read-only employee handoffs through the live, local Entra Local/Kong showcase.
import { pickEmployee } from '../../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const pw = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const engine = process.env.CLAIMS_PDF_BROWSER || 'chromium'
const options = engine === 'chromium' ? { channel: 'chrome' } :
  process.env.CLAIMS_WEBKIT_EXECUTABLE ? { executablePath: process.env.CLAIMS_WEBKIT_EXECUTABLE } : {}
const app = 'http://127.0.0.1:3180'
const shared = process.argv.includes('--shared')
const chatLocation = url => shared ? url.origin === app && url.pathname === '/chat' : url.port === '3183'
const raw = app + '/claims/api/media/WC-101/WC-101-report?format=pdf'
const browser = await pw[engine].launch(options)
const context = await browser.newContext({ viewport: { width: 1450, height: 950 } })
const page = await context.newPage()
page.setDefaultTimeout(15000)
async function signIn(user, target = page) {
  await pickEmployee(target, user)
}
try {
  for (const [name, answer] of [['Preview Notice', 'Continue'], ['Add an API key to get started', 'Configure later']])
    await page.addLocatorHandler(page.getByRole('dialog', { name }), () => page.getByRole('button', { name: answer, exact: true }).click())
  assert.equal((await page.request.get(app + '/health/ready')).status(), 200, 'The showcase must be ready through Kong')
  // Directly following the old PDF URL resumes the viewer, including when the session is missing.
  await page.goto(raw, { waitUntil: 'commit' })
  await signIn('maya')
  await page.getByRole('status').filter({ hasText: '1 page' }).waitFor()
  assert.match(await page.locator('figcaption').textContent(), /Callback diary/)
  assert.equal((await page.request.get(raw)).headers()['content-type'], 'application/pdf')
  const targeted = app + '/?mode=workbench&record=WC-101&view=sources&source=WC-101-report#workbench'
  await page.goto(targeted)
  await page.getByRole('link', { name: 'Open PDF' }).click()
  const pdf = page.frameLocator('iframe[title="Claim PDF viewer"]')
  await pdf.getByRole('status').filter({ hasText: '1 page' }).waitFor()
  assert.match(await pdf.locator('figcaption').textContent(), /Callback diary/)
  await page.getByRole('button', { name: 'Close PDF' }).click()
  assert.equal(new URL(page.url()).searchParams.get('source'), 'WC-101-report')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  const open = page.getByRole('link', { name: 'Open in Chat' })
  const id = new URL(await open.getAttribute('href'), app).searchParams.get('conversation')
  assert.ok(id)
  assert.equal(await open.getAttribute('target'), null)
  await open.click()
  await page.waitForURL(u => chatLocation(u) && u.searchParams.get('conversation') === id && u.hash === '#claim-chat')
  await page.getByRole('button', { name: 'Choose scope', exact: true }).waitFor()
  assert.equal(context.pages().length, 1)
  assert.equal((await (await page.request.get(app + '/claims/api/chat/conversation/' + id)).json()).scope.claimIds[0], 'WC-101')
  // Expire the browser at the reported entry point with the drawer and its link still open.
  const drawer = await context.newPage()
  await drawer.goto(targeted)
  await drawer.getByRole('button', { name: 'Ask agent', exact: true }).click()
  const reopen = drawer.getByRole('link', { name: 'Open in Chat' })
  const resumed = new URL(await reopen.getAttribute('href'), app).searchParams.get('conversation')
  await page.close()
  await context.clearCookies()
  await drawer.evaluate(() => window.dispatchEvent(new Event('focus')))
  await drawer.getByRole('link', { name: 'Sign in to resume this conversation' }).click()
  await signIn('maya', drawer)
  await drawer.waitForURL(u => chatLocation(u) && u.searchParams.get('conversation') === resumed && u.hash === '#claim-chat')
  await drawer.getByRole('button', { name: 'Choose scope', exact: true }).waitFor()
  // A genuine server revocation must also let the native watcher recover the bound conversation.
  const { csrfToken } = await (await drawer.request.get(app + '/auth/me')).json()
  const revoked = await drawer.request.post(app + '/auth/logout', { headers: { Origin: app, 'X-CSRF-Token': csrfToken } })
  assert.ok(revoked.ok())
  await signIn('maya', drawer)
  await drawer.waitForURL(u => chatLocation(u) && u.searchParams.get('conversation') === resumed && u.hash === '#claim-chat')
  await drawer.getByRole('button', { name: 'Choose scope', exact: true }).waitFor()
  const other = await browser.newContext()
  const alex = await other.newPage()
  await alex.goto(app + '/open-workbench', { waitUntil: 'commit' })
  await signIn('alex', alex)
  assert.equal((await alex.request.get(raw)).status(), 404)
  assert.equal((await alex.request.get(app + '/claims/api/chat/conversation/' + id)).status(), 404)
  await other.close()
  console.log(engine + ' verified Maya’s WC-101 preview, direct PDF sign-in, same-tab native handoff and conversation after reauthentication and live session revocation, Alex’s denials.')
} catch (error) {
  const active = browser.contexts().flatMap(c => c.pages()).at(-1)
  if (active) {
    const u = new URL(active.url())
    console.error(engine + ' live check stopped on', u.origin + u.pathname, (await active.locator('h1').allTextContents()).join(', '))
  }
  throw error
} finally { await browser.close() }
