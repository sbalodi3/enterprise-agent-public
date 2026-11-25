import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

test('an existing custom profile is preserved before the launcher creates any files or links', async (t) => {
  const launch = fileURLToPath(new URL('../runtime/launch.mjs', import.meta.url))
  for (const [name, content] of [
    ['cordis.patch.yml', '# custom patch\n'],
    ['cordis.yml', ''],
    ['package.json', '{"private":true}\n'],
  ]) {
    await t.test(name, async (t) => {
      const home = await mkdtemp(join(tmpdir(), 'claims-launch-'))
      t.after(() => rm(home, { recursive: true, force: true }))
      const dir = join(home, 'profiles', 'claims-workbench')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, name), content)
      const options = { env: { ...process.env, DSH_PROFILE: 'claims-workbench', DSH_HOME: home } }
      await assert.rejects(
        promisify(execFile)(process.execPath, [launch, '--dump-config'], options),
        /Existing unmanaged claims profile/,
      )
      assert.deepEqual(await readdir(dir), [name])
      assert.equal(await readFile(join(dir, name), 'utf8'), content)
    })
  }
})

test('a real boot may annotate the empty profile root and a second launch preserves it', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claims-relaunch-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const launch = fileURLToPath(new URL('../runtime/launch.mjs', import.meta.url))
  const env = { ...process.env, DSH_PROFILE: 'claims-workbench', DSH_HOME: home }
  const dump = () => promisify(execFile)(process.execPath, [launch, '--dump-config'], { env })
  await dump()
  const path = join(home, 'profiles', 'claims-workbench', 'cordis.yml')
  const generated = await readFile(path, 'utf8')
  assert.match(generated, /^# dsh profile root/)
  await dump()
  assert.equal(await readFile(path, 'utf8'), generated)
  await writeFile(path, generated.replace('[]', '- id: custom'))
  await assert.rejects(dump(), /Existing unmanaged claims profile/)
})
