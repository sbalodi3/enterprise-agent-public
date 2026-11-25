import assert from 'node:assert/strict'
import test from 'node:test'
import { createDepartmentAssistant } from '../portfolios/assistant.mjs'
import { departmentProfiles } from '../portfolios/profiles.mjs'

function fixture(choose) {
  const saved = []
  const row = {
    id: 'FIN-207',
    version: 3,
    owner: 'finance',
    sourceVersions: [['INV-318', 1]],
    sources: [
      { id: 'INV-318', title: 'Supplier invoice', passages: [{ id: 'expense', text: 'EXP-044 · $600.00' }] },
    ],
  }
  const params = {
    user: { tenantId: 'demo', subject: 'sam-subject', principalId: 'finance' },
    profile: departmentProfiles.finance,
    recordId: row.id,
    question: 'What is the variance?',
    recheck() {},
  }
  const service = createDepartmentAssistant({
    signal: new AbortController().signal,
    store: {
      async detail() {
        return row
      },
      async ask() {
        return {
          text: 'Staged minus invoiced is $600.00.',
          sources: [{ recordId: row.id, sourceId: 'INV-318', anchorId: 'expense', title: 'Supplier invoice' }],
        }
      },
    },
    pool: {
      async query(sql, args) {
        const key = JSON.stringify(args.slice(0, 6))
        if (sql.includes('INSERT')) {
          saved.push({ key, id: args[6], question: args[7], answer: args[8] })
          return {}
        }
        return { rows: saved.filter((r) => r.key === key) }
      },
    },
    choose: (...args) => choose(row, ...args),
  })
  return { service, row, saved, params }
}

test('asking uses verified records and protected history follows the employee, scope and current source versions', async () => {
  const { service, row, params } = fixture(async (_row, _llm, _model, _signal, context) => {
    assert.equal(context.evidence[0].text, 'Staged minus invoiced is $600.00.')
    return [1]
  })
  const answer = await service.ask(params)
  assert.equal(answer.text, 'Staged minus invoiced is $600.00.')
  assert.equal(answer.sources[0].sourceId, 'INV-318')
  assert.equal((await service.history(params)).items.length, 1)
  assert.deepEqual(
    (await service.history({ ...params, user: { ...params.user, subject: 'another-subject' } })).items,
    [],
  )
  row.sourceVersions[0][1]++
  assert.deepEqual((await service.history(params)).items, [])
})

test('source revisions and sign-out during inference prevent publishing and saving the answer', async () => {
  const revised = fixture(async (row) => {
    row.version++
    return [1]
  })
  await assert.rejects(revised.service.ask(revised.params), { code: 'stale_version' })
  assert.equal(revised.saved.length, 0)
  let active = true
  const signedOut = fixture(async () => {
    active = false
    return [1]
  })
  await assert.rejects(
    signedOut.service.ask({
      ...signedOut.params,
      recheck() {
        if (!active) throw Error('signed out')
      },
    }),
    /signed out/,
  )
  assert.equal(signedOut.saved.length, 0)
})
