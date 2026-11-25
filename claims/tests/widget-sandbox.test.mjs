import assert from 'node:assert/strict'
import { test } from 'node:test'
import { widgetSettings, startConfiguredWidgetSandbox, startWidgetSandbox } from '../runtime/widget-sandbox.mjs'

test('only explicit HTTPS production parents can frame the dedicated widget hostname', () => {
  const env = { CLAIMS_APP_ORIGIN: 'https://work.example', CLAIMS_WIDGET_ORIGIN: 'https://widget.example',
    CLAIMS_WIDGET_PARENT_ORIGINS: 'https://chat.example' }
  assert.deepEqual([...widgetSettings(env).parents], ['https://work.example', 'https://chat.example'])
  assert.equal(widgetSettings({ ...env, CLAIMS_WIDGETS_DISABLED: '1' }), null)
  for (const origin of ['https://work.example:8443', 'https://chat.example', 'http://widget.example', 'https://widget.example/path'])
    assert.throws(() => widgetSettings({ ...env, CLAIMS_WIDGET_ORIGIN: origin }))
})

test('invalid configuration or an unavailable listener leaves the host in text mode', async () => {
  const env = { CLAIMS_APP_ORIGIN:'http://localhost:3080', CLAIMS_WIDGET_ORIGIN:'http://claims-widgets.localhost:4380' }
  const messages = []
  const warn = msg => messages.push(msg)
  assert.equal(await startConfiguredWidgetSandbox({ ...env, CLAIMS_WIDGET_ORIGIN:env.CLAIMS_APP_ORIGIN }, warn),null)
  assert.equal(await startConfiguredWidgetSandbox({ ...env, CLAIMS_WIDGET_LISTEN_PORT:'65536' }, warn),null)
  assert.equal(messages.length,2)
})
test('sandbox serves only the proxy on its named host to an allowed parent', async t => {
  const parent = 'http://localhost:3080'
  const settings = { origin: 'http://127.0.0.1', parents: new Set([parent]) }
  const server = await startWidgetSandbox(settings, 0, '127.0.0.1')
  t.after(() => { server.close(); server.closeAllConnections() })
  settings.origin += ':' + server.address().port
  const proxy = '/proxy?parent=' + encodeURIComponent(parent)
  const result = await fetch(settings.origin + proxy)
  assert.equal(result.status, 200)
  assert.ok(result.headers.get('content-security-policy').includes('frame-ancestors ' + parent))
  assert.ok(result.headers.get('content-security-policy').includes("connect-src 'none'"))
  assert.equal(result.headers.get('set-cookie'), null)
  for (const path of ['/', '/claims/api/status', '/proxy?parent=https://other.example'])
    assert.equal((await fetch(settings.origin + path)).status, 404)
  assert.equal((await fetch(settings.origin + proxy, { method: 'POST' })).status, 404)
})
