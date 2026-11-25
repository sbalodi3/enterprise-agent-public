// A real local PDF.js worker reads the same synthetic WC-101 and WC-103 bytes served by the showcase.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { registerPdfViewer } from '../../runtime/pdf-viewer.mjs'
import { pdfViewerHref } from '../pdf-link.mjs'
import { getDocument, renderDocumentPdf } from '../../showcase/data/documents.mjs'

const pw = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const engine = process.env.CLAIMS_PDF_BROWSER || 'chromium'
const browser = await pw[engine].launch(engine === 'chromium' ? { channel: 'chrome' } :
  process.env.CLAIMS_WEBKIT_EXECUTABLE ? { executablePath: process.env.CLAIMS_WEBKIT_EXECUTABLE } : {})
const assets = new Map()
let handle, signedIn = true, attached = true
await registerPdfViewer({
  claimsAuth: { admit: () => signedIn ? { peer: {} } : { rejection: 401 } },
  effect: f => f(), webServer: { register: route => { handle = route.handler } },
}, assets)
for (const file of ['pdf-link.mjs', 'claim-pdf.css', 'claim-pdf.mjs']) {
  assets.set('/claims/assets/' + file, { type: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url)) })
}
const conversation = '9d37fa50-1dda-42b1-b1df-c555821c703b'
const wc101 = pdfViewerHref({ claimId: 'WC-101', documentId: 'WC-101-report' })
const wc103 = pdfViewerHref({ conversation, claimId: 'WC-103', claimVersion: 1, documentId: 'WC-103-shift', documentVersion: 1, anchorId: 'date' })
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/claims/view-pdf') return handle(req, res)
  const asset = assets.get(url.pathname)
  if (asset) return res.writeHead(200, { 'content-type': asset.type }).end(asset.body)
  if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(
    '<title>Workbench</title><a id="report" href="' + wc101 + '">Open PDF</a><script type="module">import {openPdfDialog} from "/claims/assets/pdf-link.mjs";document.querySelector("a").onclick=openPdfDialog</script>')
  if (!signedIn) return res.writeHead(401).end()
  let doc
  if (url.pathname === '/claims/api/media/WC-101/WC-101-report') doc = getDocument('WC-101-report')
  if (url.pathname === '/claims/api/chat/source/' + conversation && url.searchParams.get('documentId') === 'WC-103-shift' &&
      url.searchParams.get('claimVersion') === '1' && url.searchParams.get('documentVersion') === '1' && url.searchParams.get('anchorId') === 'date') doc = getDocument('WC-103-shift')
  if (!doc || !attached) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' }).end(renderDocumentPdf(doc))
})
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(origin)
  await page.getByRole('link', { name: 'Open PDF' }).click()
  const frame = page.frameLocator('iframe[title="Claim PDF viewer"]')
  await frame.getByRole('status').filter({ hasText: '1 page' }).waitFor().catch(async error => {
    console.error('PDF status', await frame.getByRole('status').textContent(), errors)
    throw error
  })
  assert.match(await frame.locator('figcaption').textContent(), /Callback diary/)
  const download = page.waitForEvent('download')
  await frame.getByRole('button', { name: 'Download' }).click()
  const saved = await download
  assert.equal(saved.suggestedFilename(), 'WC-101-report.pdf')
  assert.equal((await readFile(await saved.path())).subarray(0, 5).toString(), '%PDF-')
  const popup = page.waitForEvent('popup')
  await frame.getByRole('link', { name: 'Open in new tab' }).click()
  const tab = await popup
  await tab.getByRole('status').filter({ hasText: '1 page' }).waitFor()
  await tab.close()
  await page.getByRole('button', { name: 'Close PDF' }).click()
  await page.locator('dialog').waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => document.activeElement.id), 'report')
  await page.goto(origin + wc103)
  await page.getByRole('status').filter({ hasText: 'Cited passage date' }).waitFor()
  assert.match(await page.locator('figcaption').textContent(), /November 10/)
  attached = false
  await page.getByRole('button', { name: 'Download' }).click()
  await page.getByRole('status').filter({ hasText: 'unavailable for this account' }).waitFor()
  assert.equal(await page.locator('canvas').count(), 0)
  signedIn = false
  const login = await page.request.get(origin + wc103, { maxRedirects: 0 })
  assert.equal(login.status(), 303)
  assert.equal(new URL(login.headers().location, origin).searchParams.get('resume'), wc103)
  assert.deepEqual(errors, [])
  console.log(engine + ' rendered WC-101, downloaded it, opened a new tab, followed WC-103’s anchored source and enforced fresh access.')
} finally {
  await browser.close()
  server.closeAllConnections()
  server.close()
}
