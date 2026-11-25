import { askDepartment } from './ask-department.mjs'
// Read-only acceptance except for each employee's own saved assistant answer.
import { pickEmployee } from '../../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const origin = process.env.CLAIMS_TEST_ORIGIN || 'http://127.0.0.1:3180'
const project = new URL(origin).port === '3280' ? 'enterprise-agent' : 'claims-showcase'
const config = process.env.CLAIMS_MODEL_ID ? {} : parseEnv(
  await readFile(new URL('../../../.artifacts/' + project + '/.env', import.meta.url), 'utf8'),
)
const expectedModel = process.env.CLAIMS_MODEL_ID || config.CLAIMS_MODEL_ID || 'claims-local'
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })

async function check({ department, id, title, question, expected, privateRecord, sourceId }) {
  const context = await browser.newContext({ viewport: { width: 1540, height: 960 } })
  try {
    const page = await context.newPage()
    await page.goto(origin + '/open-workbench')
    await pickEmployee(page, department)
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
    await page.getByRole('button', { name: new RegExp('^Open ' + id) }).click()
    const api = origin + '/claims/api/departments/'
    const records = api + department + '/records'
    assert.equal((await (await page.request.get(records)).json()).items.length, 6)
    const other = department === 'legal' ? 'finance' : 'legal'
    assert.equal((await page.request.get(api + other + '/records/' + privateRecord)).status(), 404)
    assert.equal((await page.request.get(records + '/' + privateRecord + '/ask')).status(), 404)
    assert.equal((await page.request.get(origin + '/claims/api/items/WC-103')).status(), 404)
    const pdf = await page.request.get(records + '/' + id + '/sources/' + sourceId + '?format=pdf')
    assert.equal(pdf.headers()['content-type'], 'application/pdf')
    assert.equal((await pdf.body()).subarray(0, 4).toString(), '%PDF')
    const stalePdf = await page.request.get(records + '/' + id + '/sources/' + sourceId + '?format=pdf&version=999')
    assert.equal(stalePdf.status(), 409)
    const { answer } = await askDepartment(page, department, id, question)
    assert.equal(answer.model, expectedModel)
    assert.equal(answer.mode, 'live')
    assert.ok(answer.sources.length)
    for (const pattern of expected) assert.match(answer.text, pattern)
    const target = answer.sources[0]
    const doc = await (
      await page.request.get(records + '/' + target.recordId + '/sources/' + target.sourceId)
    ).json()
    assert.ok(doc.passages.some((p) => p.id === target.anchorId))
    console.log(
      'PASS',
      department,
      'scoped Chat, exact source and PDF, protected history and six records with',
      answer.model,
    )
  } finally {
    await context.close()
  }
}

try {
  await check({
    department: 'legal',
    id: 'MAT-017',
    title: 'Legal Matters',
    privateRecord: 'FIN-207',
    sourceId: 'WC-103-report',
    question:
      'Prepare the factual incident chronology. Which reported dates differ, and when was the handover recorded?',
    expected: [/November 9/, /November 10/, /November 17/],
  })
  await check({
    department: 'finance',
    id: 'FIN-207',
    title: 'Finance Billing Review',
    privateRecord: 'MAT-017',
    sourceId: 'INV-318',
    question: 'What explains the variance between the supplier invoice and the staged client bill?',
    expected: [/9,000/, /9,600/, /600/, /EXP-044/],
  })
} finally {
  await browser.close()
}
