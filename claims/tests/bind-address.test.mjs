import test from 'node:test'
import assert from 'node:assert/strict'
import { containerAddress } from '../runtime/bind-address.mjs'

test('the Workbench listener and readiness select ingress even if the model interface is first', () => {
  const interfaces = {
    scope0: [{ family: 'IPv4', address: '192.0.2.12', internal: false }],
    claims0: [{ family: 'IPv4', address: '192.0.2.15', internal: false }],
  }
  assert.equal(containerAddress(interfaces, 'claims0'), '192.0.2.15')
  assert.equal(containerAddress(interfaces, 'missing'), undefined)
})
