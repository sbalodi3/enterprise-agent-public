import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installAssistant, renderComparison, renderPriority } from '../runtime/assistant.mjs'
import { validateProfile } from '../runtime/profile.mjs'

// Use the built harness's own native executor, model adapter and session log.
const resolve = createRequire(
  new URL('../../packages/preset/agent-preset-registry/package.json', import.meta.url),
).resolve
const pkg = (name) => import(pathToFileURL(resolve('@deepseek-ai/' + name)).href)
const profile = validateProfile(
  JSON.parse(await readFile(new URL('../profiles/claims-v1.json', import.meta.url))),
)
test('claims replay runs through a real agent with only the scoped tools', async (t) => {
  const { Context } = await pkg('cordis')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.baseUrl = import.meta.url
  await ctx.plugin((await pkg('cordis-plugin-loader')).default)
  ctx.loader.builtins.group = (await pkg('cordis-plugin-group')).default
  for (const name of [
    'llm',
    'session',
    'session-projection',
    'system-prompt',
    'tools',
    'tool-executor-native',
    'agent',
    'agent-loop',
  ]) {
    const plugin = await pkg('dsh-' + name)
    await ctx.plugin(plugin.default || plugin, name === 'agent-loop' ? { agents: [] } : {})
  }
  const registry = await import('../../packages/preset/agent-preset-registry/lib/index.js')
  await ctx.plugin(registry.default, { default: profile.id })
  await ctx.agentPresets.register({ id: profile.id, plugins: [] })
  ctx.tools.register({
    name: 'restricted',
    description: 'Unrelated tool',
    output: { schema: { type: 'string' }, render: () => [] },
    parameters: { type: 'object', properties: {} },
    execute: () => assert.fail('Unrelated tool ran'),
  })
  const detail = {
    item: {
      id: 'demo',
      title: 'Callback',
      ownerId: 'maya',
      version: 1,
      reason: 'Promised callback due',
      nextAction: 'Review diary',
      source: 'Diary',
      asOf: 'noon',
    },
    timeline: [],
    evidence: [{ id: 'demo-source', title: 'Recorded promise' }],
  }
  const domain = {
    detail: async () => detail,
    bindSession: async () => {},
    finishSession: async () => {},
    failSession: async () => {},
  }
  let visibleTools
  const calledTools = []
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'request/header') visibleTools = event.data.header.tools.map((t) => t.name).sort()
    if (event.type === 'assistant/message')
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') calledTools.push(block.name)
      }
  })
  const assist = installAssistant(ctx, domain, profile)
  let checked = 0
  const options = { task: 'explain_priority', mode: 'replay', itemId: 'demo', expectedVersion: 1 }
  const result = await assist({ principalId: 'maya' }, options, () => {
    checked++
  })
  const expected = JSON.parse(await readFile(new URL('./fixtures/replay-priority.json', import.meta.url)))
  assert.deepEqual(
    {
      mode: result.mode,
      profileRelease: result.profileRelease,
      visibleTools,
      calledTools,
      text: result.text,
      sourceIds: result.sources.map((x) => x.id),
    },
    expected,
  )
  assert.ok(checked >= 4)
  await assert.rejects(
    assist({}, { ...options, expectedVersion: 2 }, () => {}),
    { code: 'stale_version' },
  )
})

test('live comparisons publish only model-selected, source-verifiable passages', () => {
  const source = { id: 'diary-7', title: 'Diary', body: 'Caller requested a callback.' }
  const selection = JSON.stringify({ excerpts: [{ id: 'diary-7', quote: 'requested a callback' }] })
  assert.equal(
    renderComparison(selection, [source]),
    'Diary [diary-7] — requested a callback\nOnly one source is available for comparison.',
  )
  assert.equal(renderComparison('The timeline has no changes [diary-7]', [source]), null)
  assert.equal(
    renderComparison(selection.replace('requested a callback', 'no later entries'), [source]),
    null,
  )
  assert.equal(renderComparison(selection.replace('diary-7', 'other-source'), [source]), null)
  assert.equal(renderComparison(selection, [source, { ...source, id: 'diary-8' }]), null)
})

test('live priority preserves source dates and citations when the model ranks verified facts', () => {
  const record = {
    item: {
      reason: 'Promised callback',
      nextAction: 'Call back',
      dueAt: '2026-11-17T15:00:00.000Z',
      ownerId: 'maya',
      source: 'Diary',
      asOf: '2026-11-17T14:00:00.000Z',
    },
    evidence: [{ id: 'source-WC-101', title: 'Diary entry' }],
  }
  const answer = renderPriority('{"fields":["reason"]}', record)
  assert.match(answer, /2026-11-17T15:00:00.000Z/)
  assert.match(answer, /\[source-WC-101\]/)
  assert.equal(renderPriority('{"fields":["made-up obligation"]}', record), null)
})
