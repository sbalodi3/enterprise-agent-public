import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pickEmployee } from './picker.mjs'

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require(process.env.CLAIMS_TEST_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CLAIMS_TEST_ORIGIN || 'http://127.0.0.1:3280')
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname))
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  let watches = 0
  await page.route('**/auth/session-watch', route => {
    watches++
    return watches === 1 ? route.abort('internetdisconnected') : route.continue()
  })

  const stale = await page.goto(new URL('/auth/callback?code=stale&state=stale', origin).href)
  assert.equal(stale.status(), 400)
  assert.match(stale.headers()['content-type'], /^text\/html/)
  assert.equal(stale.headers()['cache-control'], 'no-store')
  await page.getByRole('heading', { name: 'Sign in again' }).waitFor()
  await page.getByRole('link', { name: 'Start a new sign-in' }).click()
  const callback = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/callback')
  const watch = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/session-watch' && response.ok())
  await pickEmployee(page, 'maya')
  const completed = await callback
  assert.equal(completed.status(), 200)
  const cookies = await completed.headerValues('set-cookie')
  assert.match(cookies.find(cookie => cookie.startsWith('claims_session_dev=')), /Max-Age=43200(?:;|$)/)
  await page.waitForURL(url => url.origin === origin.origin && url.pathname === '/chat')
  await watch
  assert.ok(watches >= 2, 'Chat should reconnect its session watch after an interrupted stream')

  const identity = await context.request.get(new URL('/auth/me', origin).href)
  const { user, csrfToken } = await identity.json()
  assert.equal(user.principalId, 'maya')
  const logout = await context.request.post(new URL('/auth/logout', origin).href, {
    headers: { origin: origin.origin, 'x-csrf-token': csrfToken },
  })
  assert.equal(logout.status(), 200)
  await page.waitForURL(url => url.pathname === '/auth/signed-out')
  assert.equal((await context.request.get(new URL('/auth/me', origin).href)).status(), 401)

  const replay = await page.goto(completed.url())
  assert.equal(replay.status(), 400)
  await page.getByRole('link', { name: 'Start a new sign-in' }).waitFor()
  assert.equal((await context.request.get(new URL('/auth/me', origin).href)).status(), 401)
  console.log('Verified 12-hour sign-in, expired callback recovery, stream reconnection, and logout in Podman.')
} finally {
  await browser.close()
}
