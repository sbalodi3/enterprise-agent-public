import { askDepartment } from './ask-department.mjs'
// By default this smoke performs only employee reads. --exercise requires an isolated local showcase.
import { pickEmployee } from '../../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')

const app = new URL(process.env.PORTFOLIO_DEMO_ORIGIN || 'http://127.0.0.1:3180')
const exercise = process.argv.includes('--exercise')
if (
  app.hostname !== '127.0.0.1' ||
  app.protocol !== 'http:' ||
  app.pathname !== '/' ||
  app.username ||
  app.password
)
  throw Error('Use a local showcase origin')
if (exercise && (!process.env.PORTFOLIO_DEMO_ORIGIN || ['3180', '3080'].includes(app.port)))
  throw Error('Run --exercise against a disposable showcase with its own origin and database')
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' })
const api = (page, scope, record) =>
  page.request.get(new URL('/claims/api/departments/' + scope + '/records/' + record, app).href)
async function signIn(user) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  await page.goto(new URL('/open-workbench', app).href)
  await pickEmployee(page, user)
  return page
}
async function approve(page, label, preview) {
  await button(page, label).click()
  const modal = page.getByRole('dialog', { name: label })
  assert.match(await modal.innerText(), preview)
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/actions/'))
  await button(modal, 'Confirm ' + label.toLowerCase()).click()
  const res = await posted
  assert.ok(res.ok(), 'Approval returned HTTP ' + res.status())
  await modal.waitFor({ state: 'hidden' })
}
async function awaitDelivery(page, department, id, state) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const res = await api(page, department, id)
    assert.ok(res.ok())
    const body = await res.json()
    if (body.referral?.state === state) return body
    await delay(200)
  }
  throw Error('Did not receive ' + state + ' for ' + id)
}
try {
  const finance = await signIn('finance')
  await button(finance, /^Open FIN-207 /).click()
  const variance = button(finance, 'Highlight variance +$600.00')
  await variance.click()
  assert.equal(await finance.locator('tr.dp-highlight').count(), 3)
  const legal = await signIn('legal')
  await button(legal, /^Open MAT-017 /).click()
  await legal.getByText('Incident date in supervisor report', { exact: true }).waitFor()
  assert.equal((await api(finance, 'legal', 'MAT-017/sources/PREP-017')).status(), 404)
  assert.equal((await api(legal, 'finance', 'FIN-207')).status(), 404)
  console.log(
    'PASS separate signed-in portfolios, source-linked variance, and cross-department access checks',
  )
  if (exercise) {
    const f0 = await (await api(finance, 'finance', 'FIN-207')).json()
    const l0 = await (await api(legal, 'legal', 'MAT-017')).json()
    assert.ok(!f0.receipts.length && !l0.receipts.length, 'This exercise needs freshly seeded demo records')
    await approve(legal, 'Approve factual packet', /November 9[\s\S]*November 10/)
    await legal.getByRole('heading', { name: 'Receipts' }).waitFor()
    await legal.getByText('View destination record', { exact: true }).click()
    const packet = legal.locator('.dp-destination:visible')
    assert.match(await packet.innerText(), /PACKET-/)
    assert.match(await packet.innerText(), /November 9[\s\S]*November 10/)
    assert.match(await packet.innerText(), /Independent confirmation/)
    assert.doesNotMatch(await packet.innerText(), /PREP-017|AUTH-600-01|interview sequencing/)
    await approve(finance, 'Open billing review', /\$600\.00|\$600/)
    await finance.getByRole('heading', { name: 'Receipts' }).waitFor()
    await finance.getByText('View destination record', { exact: true }).click()
    const register = finance.locator('.dp-destination:visible')
    assert.match(await register.innerText(), /BILLREV-/)
    assert.match(await register.innerText(), /Supplier invoice[^\n]*\$9,000\.00/)
    assert.match(await register.innerText(), /Staged client bill[^\n]*\$9,600\.00/)
    assert.match(await register.innerText(), /Variance[^\n]*\$600\.00/)
    await approve(finance, 'Ask Legal to verify expense', /INV-318[\s\S]*EXP-044/)
    const waiting = await awaitDelivery(finance, 'finance', 'FIN-207', 'awaiting_legal')
    assert.equal(waiting.referral.reference, undefined)
    const ownedSourcePath = 'FIN-207/sources/A2A-' + waiting.referral.id
    assert.equal((await api(finance, 'finance', ownedSourcePath)).status(), 404)
    await button(legal, 'Inbox').click()
    await button(legal, /^Open message Finance authorization request/).click()
    await approve(legal, 'Approve reply to Finance', /AUTH-600-01/)
    const done = await awaitDelivery(finance, 'finance', 'FIN-207', 'completed')
    assert.equal(done.referral.id, waiting.referral.id)
    assert.equal(done.referral.reference, 'AUTH-600-01')
    assert.equal(done.referral.disposition, 'no_amendment')
    assert.doesNotMatch(JSON.stringify(done), /PREP-017|interview sequencing/)
    assert.equal(done.reconciliation.varianceCents, 60000)
    assert.match(done.receipts.find((r) => r.action === 'open_review').id, /^REV-/)
    await button(finance, 'Inbox').click()
    await button(finance, /^Open message Legal authorization reply/).click()
    await finance.getByText('Shared reference · AUTH-600-01', { exact: true }).waitFor()
    const document = await (await api(finance, 'finance', ownedSourcePath + '?version=1')).json()
    assert.equal(document.kind, 'Approved A2A response')
    assert.equal(document.id, 'A2A-' + waiting.referral.id)
    assert.match(document.passages.find((p) => p.id === 'disposition').text, /No second authorization/)
    assert.equal((await api(finance, 'finance', 'FIN-207/sources/AUTH-600-01')).status(), 404)
    const {answer, shared} = await askDepartment(finance, 'finance', 'FIN-207', 'Was a second $600 expense authorized?')
    assert.equal(answer.mode, 'live')
    assert.equal(answer.model, process.env.CLAIMS_MODEL_ID || 'nemotron-3.5-lightning:30b-mlx')
    assert.match(answer.text, /No second authorization/)
    assert.ok(
      answer.sources.some(
        (ref) =>
          ref.recordId === 'FIN-207' &&
          ref.sourceId === document.id &&
          ref.anchorId === 'disposition' &&
          ref.version === 1,
      ),
    )
    let pdfLink
    if (shared) {
      pdfLink = await finance.getByRole('link', {name:document.title, exact:true}).last().getAttribute('href')
    } else {
      await button(finance.locator('.dp-answer').last(), document.title).click()
      const cited = finance.getByRole('dialog', { name: 'Source document' })
      await cited.locator('.dp-marked').waitFor()
      assert.match(await cited.locator('.dp-marked').innerText(), /No second authorization/)
      pdfLink = await cited.getByRole('link', { name: 'Open PDF' }).getAttribute('href')
    }
    assert.equal(new URL(pdfLink, app).hash, '#nameddest=disposition')
    const pdf = await finance.request.get(new URL(pdfLink, app).href)
    assert.equal(pdf.headers()['content-type'], 'application/pdf')
    assert.ok((await pdf.body()).subarray(0, 5).equals(Buffer.from('%PDF-')))
    console.log(
      'PASS filed destination fields, live Finance model answer, and versioned returned-source PDF at its disposition anchor',
    )
    console.log(
      'PASS approved packet, billing review receipt, Legal inbox, human reply, matching A2A task and Finance receipt',
    )
  }
  const matter = await (await api(legal, 'legal', 'MAT-017')).json()
  if (matter.receipts.some((r) => r.action === 'approve_packet')) {
    const alex = await signIn('alex')
    const mailbox = await alex.request.get(new URL('/claims/api/mailbox', app).href)
    assert.ok(mailbox.ok())
    const item = (await mailbox.json()).items.find(
      (m) => m.itemId === 'WC-103' && m.kind === 'Legal packet filed',
    )
    assert.ok(item, 'Approved packet notice reaches the assigned claims employee')
    assert.match(item.summary, /WC-103-report \(v1\).*WC-103-shift \(v1\)/)
    assert.doesNotMatch(item.summary, /PREP-017|interview sequencing/)
    assert.equal((await api(alex, 'legal', 'MAT-017/sources/PREP-017')).status(), 404)
    console.log('PASS assigned adjuster can reopen the packet status and approved references')
  }
} finally {
  await browser.close()
}
