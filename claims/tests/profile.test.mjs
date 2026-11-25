import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { validateProfile } from '../runtime/profile.mjs'
const manifest = JSON.parse(await readFile(new URL('../profiles/claims-v1.json', import.meta.url)))
test('department releases validate capabilities and freeze permitted procedures', () => {
  const example = validateProfile({
    ...manifest,
    id: 'department-test-v1',
    subjectTypes: ['test-matter'],
    capabilities: ['timeline'],
    workflows: [],
    release: '2.0.0',
  })
  assert.equal(example.id, 'department-test-v1')
  assert.deepEqual(example.capabilities, ['timeline'])
  assert.throws(() => example.capabilities.push('restricted'))
  assert.throws(() => validateProfile({ ...manifest, capabilities: ['run_code'] }))
  assert.throws(() => validateProfile({ ...manifest, evidencePolicy: 'allow-all' }))
  assert.throws(() => validateProfile({ ...manifest, chatTools: ['shell'] }))
  assert.throws(() => example.chatTools.push('read_directory'))
  const { chatTools, chatInstructions, ...previousRelease } = manifest
  assert.deepEqual(validateProfile(previousRelease).chatTools, [])
  assert.throws(() => validateProfile({ ...previousRelease, chatTools }))
})
test('the real dsh launcher composes the isolated claims and desktop runtime profiles', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-profile-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const launch = fileURLToPath(new URL('../runtime/launch.mjs', import.meta.url))
  const dump = async (profile, args = []) =>
    (
      await promisify(execFile)(process.execPath, [launch, ...args, '--dump-config'], {
        env: { ...process.env, DSH_HOME: dir, DSH_PROFILE: profile },
      })
    ).stdout
  const app = await dump('claims-workbench')
  const plugin = (config, id) =>
    config
      .split(/^- id: /m)
      .find((entry) => entry.startsWith(id + '\n'))
      ?.split(/^# ==/m)[0] || ''
  assert.match(plugin(app, 'connection'), /authentication: external/)
  const desktop = await dump('claims-worker', ['--desktop-chat'])
  for (const id of [
    'session-log-deepseek',
    'session-telemetry-otel',
    'message-feedback',
    'session-log-download',
    'desktop-product-telemetry',
    'product-analytics',
  ]) {
    assert.match(plugin(app, id), /disabled: true/, 'Workbench: ' + id)
    assert.match(plugin(desktop, id), /disabled: true/, 'Chat: ' + id)
  }
  for (const config of [app, desktop]) {
    assert.match(plugin(config, 'web-deepseek-api'), /sendOriginalQuestion: false/)
  }
  assert.match(plugin(app, 'claims-preset'), /claims-v1/)
  assert.match(plugin(app, 'claims-workbench'), /@local\/claims-workbench/)
  assert.match(desktop, /@local\/claims-desktop-chat/)
  assert.match(desktop, /http:\/\/127\.0\.0\.1:3082\/v1/)
  assert.doesNotMatch(desktop, /authentication: external|@local\/claims-workbench/)
  const worker = await dump('claims-worker')
  assert.match(worker, /claims-worker/)
  assert.doesNotMatch(worker, /@deepseek-ai\/dsh-web-app/)
})
