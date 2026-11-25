import { pdfBytesHref, pdfReference } from './pdf-link.mjs'
import { getDocument, GlobalWorkerOptions } from './pdf.min.mjs'

GlobalWorkerOptions.workerSrc = '/claims/assets/pdf.worker.min.mjs'
const ref = pdfReference(new URL(location.href).searchParams)
const status = document.querySelector('#status')
const pages = document.querySelector('#pages')
const download = document.querySelector('#download')
const signIn = document.querySelector('#sign-in')
const newTab = document.querySelector('#new-tab')
newTab.href = location.href
newTab.hidden = window === window.top
signIn.href = location.href
const control = new AbortController()
let task

async function authorizedResponse() {
  const response = await fetch(pdfBytesHref(ref), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: control.signal })
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/pdf') {
    const error = new Error('Document unavailable')
    error.status = response.status
    throw error
  }
  return response
}

async function readPdf() {
  return (await authorizedResponse()).arrayBuffer()
}

function unavailable(error) {
  if (control.signal.aborted) return
  pages.replaceChildren()
  download.disabled = true
  signIn.hidden = error.status !== 401
  status.textContent = ({
    401: 'Your sign-in has ended.', 403: 'You no longer have access to this document.',
    404: 'This document is unavailable for this account.', 409: 'This version has changed. Reopen the current source.',
  })[error.status] || 'The PDF could not be opened. Reopen the document to try again.'
}

download.onclick = async () => {
  try {
    const bytes = await readPdf()
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    const link = document.createElement('a')
    link.download = ref.documentId + '.pdf'
    link.href = objectUrl
    link.click()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch (error) { unavailable(error) }
}

let checking = false
async function recheck() {
  if (checking || download.disabled || document.visibilityState !== 'visible') return
  checking = true
  try {
    const response = await authorizedResponse()
    await response.body?.cancel()
  } catch (error) { unavailable(error) }
  finally { checking = false }
}
window.addEventListener('focus', recheck)
document.addEventListener('visibilitychange', recheck)
window.addEventListener('pagehide', () => {
  pages.replaceChildren()
  download.disabled = true
  control.abort()
  void task?.destroy()
}, { once: true })
window.addEventListener('pageshow', event => { if (event.persisted) location.reload() })
async function show() {
  if (!ref) throw new Error('Invalid reference')
  task = getDocument({ data: await readPdf(), isEvalSupported: false, useWorkerFetch: false, useSystemFonts: true })
  const pdf = await task.promise
  const destination = ref.anchorId ? await pdf.getDestination(ref.anchorId) : null
  const target = !destination ? null : Number.isInteger(destination[0]) ? destination[0] : await pdf.getPageIndex(destination[0])
  const title = document.querySelector('h1')
  const { info } = await pdf.getMetadata()
  title.textContent = info.Title || ref.documentId
  document.title = title.textContent + ' · Enterprise Agent'
  let anchor
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const natural = page.getViewport({ scale: 1 })
    const scale = Math.min(1.5, Math.max(0.25, pages.clientWidth / natural.width))
    const viewport = page.getViewport({ scale })
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    const container = document.createElement('figure')
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width * ratio)
    canvas.height = Math.ceil(viewport.height * ratio)
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'Page ' + n)
    const caption = document.createElement('figcaption')
    caption.className = 'pdf-screen-reader'
    container.append(canvas, caption)
    pages.append(container)
    await page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] }).promise
    // Safari's ReadableStream supports a reader before it supports async iteration.
    const reader = page.streamTextContent().getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        caption.append(document.createTextNode(value.items.map(item => item.str).join(' ') + ' '))
      }
    } finally { reader.releaseLock() }
    if (target === n - 1) {
      const y = Number.isFinite(destination[3]) ? viewport.convertToViewportPoint(0, destination[3])[1] : 0
      anchor = { container, y, viewport }
    }
  }
  status.textContent = pdf.numPages + (pdf.numPages === 1 ? ' page' : ' pages') + (anchor ? ' · Cited passage ' + ref.anchorId : '')
  download.disabled = false
  if (anchor) {
    const box = anchor.container.getBoundingClientRect()
    window.scrollTo(0, Math.max(0, scrollY + box.top + anchor.y * box.height / anchor.viewport.height - document.querySelector('header').offsetHeight))
  }
}
void show().catch(unavailable)
