import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { directory } from '../roster.mjs'
import { managedChatPorts } from '../../desktop-chat/modes.mjs'
import { pickEmployee } from './picker.mjs'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const shared = process.argv.includes('--shared')
const showcase = process.argv.includes('--showcase')
const cms = process.argv.includes('--cms-mcp') || process.env.CLAIMS_CMS_MCP === '1'
const roster = directory(showcase, cms)
const ports = managedChatPorts(showcase ? 3183 : 3083, showcase && cms)
const origin = new URL(process.env.CLAIMS_APP_ORIGIN || (showcase ? 'http://127.0.0.1:3180' : 'http://localhost:3080'))
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname))
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const sessions = new Map()
try {
  for (const employee of roster.employees) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(new URL('/open-workbench', origin).href)
    const picker = page.getByRole('list', { name: 'Pick an account' })
    await picker.waitFor()
    assert.equal(new URL(page.url()).pathname, '/' + roster.tenant + '/oauth2/v2.0/authorize')
    assert.equal(await picker.getByRole('button').count(), roster.employees.length)
    await pickEmployee(page, employee.principalId)
    await page.waitForURL(u => u.origin === origin.origin && u.pathname === '/')
    const get = async path => page.request.get(new URL(path, origin).href)
    const { user, csrfToken } = await (await get('/auth/me')).json()
    assert.equal(user.principalId, employee.principalId)
    assert.equal(user.subject, employee.subject)
    assert.equal(user.displayName, employee.displayName)
    assert.equal(user.tenantId, employee.tenantId)
    const role = employee.role ?? (employee.profile === 'claims-v1' ? (employee.principalId === 'supervisor' ? 'supervisor' : 'adjuster') : employee.principalId)
    assert.deepEqual(user.roles, [role])
    if (user.department) {
      assert.equal(user.department, employee.principalId)
      assert.equal((await get('/claims/api/departments/' + user.department + '/records')).status(), 200)
      assert.equal((await get('/claims/api/departments/' + (role === 'legal' ? 'finance' : 'legal') + '/records')).status(), 404)
      assert.equal((await get('/claims/api/items/WC-101')).status(), 404)
    } else {
      const portfolio = await (await get('/claims/api/portfolio')).json()
      if (!employee.sourceAdjusterId) assert.ok(portfolio.items.length > 0)
      else {
        const expected = Array.from({ length: 200 }, (_, i) => i + 1)
          .filter(n => (13 * n) % 20 + 1 === employee.sourceAdjusterId)
          .map(n => 'CLM-' + String(n).padStart(6, '0'))
        for (const path of ['/claims/api/portfolio?status=all', '/claims/api/chat/search?assignedOnly=true&status=all']) {
          const rows = (await (await get(path)).json()).items
          assert.deepEqual(rows.map(r => r.id).sort(), expected)
          assert.ok(rows.every(r => r.ownerId === user.principalId))
        }
        const detail = await get('/claims/api/items/' + expected[0])
        assert.equal(detail.status(), 200)
        assert.equal((await detail.json()).item.ownerId, employee.principalId)
      }
      assert.equal((await get('/claims/api/items/WC-101')).status(), ['supervisor','claims_admin'].includes(role) || employee.principalId === 'maya' ? 200 : 404)
      assert.equal((await get('/claims/api/items/TEST-ISOLATION')).status(), 404)
      assert.equal((await get('/claims/api/items/TEST-MATTER')).status(), 404)
      if (!showcase && employee.principalId === 'alex') assert.equal((await (await get('/claims/api/items/WC-102')).json()).canAct, false)
      const routed = await page.request.get(new URL('/auth/hosted-chat?claim=WC-101', origin).href, { maxRedirects: 0 })
      assert.equal(routed.status(), 303)
      const port = ports[user.principalId]
      assert.equal(new URL(routed.headers().location,origin).port, shared ? origin.port : String(port))
    }
    let hostedOrigin, nativeId
    if (process.argv.includes('--hosted') && (!employee.sourceAdjusterId || employee.sourceAdjusterId <= 2)) {
      const landing = await context.newPage()
      await landing.route('**/desktop/presence', route => route.abort())
      await landing.goto(new URL('/open-app', origin).href)
      if (user.department && !shared) {
        await landing.getByRole('textbox', { name: 'Question for the ' + user.department + ' agent' }).waitFor()
      } else {
        const port = ports[user.principalId]
        await landing.waitForURL(u => shared ? u.origin === origin.origin && u.pathname === '/chat' : u.port === String(port))
        hostedOrigin = new URL(landing.url()).origin
        await landing.locator('[data-composer-card]:visible').first().waitFor()
        if (shared) nativeId = await landing.locator('[data-conversation-session]:visible').first().getAttribute('data-conversation-session')
        assert.equal((await (await landing.request.get(hostedOrigin + (shared ? '/auth/me' : '/desktop/workbench/me'))).json()).user.subject, user.subject)
      }
    }
    sessions.set(user.principalId, { page, get, csrfToken, hostedOrigin, nativeId, principalId: user.principalId, subject: user.subject })
    console.log('Verified account, employee subject and portfolio for', employee.displayName)
    if (!['maya', 'alex', 'cms-adjuster-01', 'cms-adjuster-02'].includes(employee.principalId)) await context.close()
  }
  const maya = sessions.get('maya')
  const alex = sessions.get('alex')
  if (cms && process.argv.includes('--hosted')) {
    const aisha = sessions.get('cms-adjuster-01'), brandon = sessions.get('cms-adjuster-02')
    for (const [user, other] of [[aisha, brandon], [brandon, aisha]]) {
      if (shared) {
        assert.ok(other.nativeId)
        assert.equal((await user.get('/chat?session='+other.nativeId)).status(),404)
      } else {
        assert.equal((await user.page.request.get(other.hostedOrigin + '/api')).status(), 403)
        assert.equal((await user.page.request.get(other.hostedOrigin + '/desktop/workbench/me')).status(), 403)
      }
      const logout = await user.page.request.post(new URL('/auth/logout', origin).href, {
        headers: { origin: origin.origin, 'x-csrf-token': user.csrfToken },
      })
      assert.ok(logout.ok())
      assert.equal((await user.page.request.get(user.hostedOrigin + (shared ? '/auth/me' : '/api'))).status(), 401)
      assert.equal((await other.get('/auth/me')).status(), 200)
      await user.page.goto(new URL('/auth/hosted-chat', origin).href)
      await pickEmployee(user.page, user.principalId)
      await user.page.waitForURL(u => u.origin === user.hostedOrigin)
      await user.page.locator('[data-composer-card]:visible').first().waitFor()
      assert.equal((await (await user.get('/auth/me')).json()).user.subject, user.subject)
    }
    console.log('Verified both CMS workspace boundaries, isolated logout and return to the same full Chat.')
  }
  for (const { page } of [maya, alex]) await page.evaluate(async () => {
    const response = await fetch('/auth/session-watch')
    if (!response.ok) throw new Error('Session watch failed')
    window.employeeWatchClosed = false
    void response.text().then(() => { window.employeeWatchClosed = true })
  })
  let gatewayClosed
  if (maya.hostedOrigin) {
    const cookies = await maya.page.context().cookies(maya.hostedOrigin)
    const watch = await fetch(maya.hostedOrigin + (shared ? '/auth/session-watch' : '/desktop/session-watch'), {
      headers: { cookie: cookies.map(c => c.name + '=' + c.value).join('; ') }, signal: AbortSignal.timeout(15000),
    })
    assert.equal(watch.status, 200)
    gatewayClosed = watch.text().then(() => true, error => error.name === 'TypeError')
  }
  const logout = await maya.page.request.post(new URL('/auth/logout', origin).href, {
    headers: { origin: origin.origin, 'x-csrf-token': maya.csrfToken },
  })
  assert.ok(logout.ok())
  await maya.page.waitForFunction(() => window.employeeWatchClosed)
  assert.equal((await maya.get('/auth/me')).status(), 401)
  assert.equal((await alex.get('/auth/me')).status(), 200)
  assert.equal(await alex.page.evaluate(() => window.employeeWatchClosed), false)
  if (gatewayClosed) {
    assert.ok(await gatewayClosed)
    assert.equal((await maya.page.request.get(maya.hostedOrigin + (shared ? '/auth/me' : '/api'), { maxRedirects: 0 })).status(), 401)
    assert.equal((await alex.page.request.get(alex.hostedOrigin + (shared ? '/auth/me' : '/desktop/workbench/me'))).status(), 200)
  }
  await maya.page.goto(new URL('/auth/login', origin).href)
  await maya.page.getByRole('list', { name: 'Pick an account' }).waitFor()
  console.log('Verified isolated logout and fresh account selection')
} finally {
  await Promise.all(browser.contexts().map(context => context.close()))
  await browser.close()
}
