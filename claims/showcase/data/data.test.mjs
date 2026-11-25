import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { claims, intakes, wagePeriod } from './scenario.mjs'
import { buildWageDocument, getDocument, renderDocumentPdf } from './documents.mjs'

test('all open and closed synthetic work items link to versioned source sections and PDF destinations', () => {
  assert.deepEqual(
    claims.filter(c => c.lifecycle === 'open').map((c) => c.id),
    Array.from({ length: 12 }, (_, i) => `WC-${101 + i}`),
  )
  for (const owner of ['maya', 'alex']) assert.equal(claims.filter((c) => c.ownerId === owner && c.lifecycle === 'open').length, 6)
  assert.deepEqual(
    intakes.map((i) => i.ownerId),
    ['maya', 'claims-intake'],
  )
  assert.equal(claims.find((c) => c.id === 'WC-102').state, 'ready')
  for (const item of [...claims, ...intakes]) {
    for (const docId of item.documents) {
      const doc = getDocument(docId)
      assert.equal(doc.itemId, item.id)
      assert.equal(doc.version, 1)
      assert.ok(doc.anchors.length >= 2)
      const pdf = renderDocumentPdf(doc).toString('ascii')
      assert.ok(pdf.startsWith('%PDF-1.4'))
      assert.ok(pdf.endsWith('%%EOF\n'))
      for (const anchor of doc.anchors) assert.ok(pdf.includes(`(${anchor.id}) [`))
      assert.equal(new Set(doc.anchors.map((a) => a.id)).size, doc.anchors.length)
    }
  }
  assert.equal(getDocument('../../.env'), undefined)
})

test('filed candidate evidence matches the caller and every timestamp points to recorded speech', () => {
  const [personal, team] = intakes
  const candidates = personal.candidateIds.map((id) => claims.find((c) => c.id === id))
  const doc = getDocument(personal.documents[0])
  assert.ok(
    candidates.every(
      (c) =>
        c.ownerId === personal.ownerId &&
        c.claimant === personal.claimant &&
        c.employer === personal.employer,
    ),
  )
  const quote = doc.anchors.find((a) => a.id === 'worksite').text
  assert.deepEqual(
    candidates.filter((c) => quote.includes(c.site)).map((c) => c.id),
    ['WC-105'],
  )
  assert.deepEqual(team.candidateIds, [])
  const wav = readFileSync(new URL('../assets/IN-201-call.wav', import.meta.url))
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 36, 40), 'data')
  const samples = wav.readUInt32LE(40) / 2
  const rate = wav.readUInt32LE(24)
  let end = 0
  for (const line of doc.anchors) {
    assert.ok(line.startSeconds >= end && line.endSeconds <= samples / rate)
    let peak = 0
    for (let i = Math.ceil(line.startSeconds * rate); i < Math.floor(line.endSeconds * rate); i++)
      peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)))
    assert.ok(peak > 1000, `audible speech in ${line.id}`)
    end = line.endSeconds
  }
})

test('wage statement derives amounts, coverage, and citations from returned data, including overlapping periods', () => {
  const period = {
    periodStart: '2026-02-09',
    periodEnd: '2026-02-22',
    grossEarnings: { amount: '741.62', currency: 'USD' },
    hours: { regular: 38, overtime: 2 },
  }
  const artifact = {
    data: { payPeriods: [period, { ...period, periodStart: '2026-02-19', periodEnd: '2026-02-25' }] },
    provenance: {
      sourceSystem: 'fixture-employer',
      asOf: '2026-03-01T12:00:00Z',
      recordIds: ['test-record'],
    },
  }
  const doc = buildWageDocument('WC-102', { requestId: 'unit-example', artifact, ...wagePeriod })
  assert.equal(doc.id, 'wage-unit-example')
  assert.match(doc.anchors[0].text, /17 of 364 requested days\. Partial coverage/)
  assert.match(doc.anchors[1].text, /USD 741.62/)
  assert.match(doc.anchors.at(-2).text, /test-record/)
  assert.match(renderDocumentPdf(doc).toString(), /741\.62/)
})
