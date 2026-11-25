// The viewer accepts record identities only. Each PDF fetch goes through the original record authority.
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const version = /^[1-9]\d{0,8}$/

export function pdfViewerHref(ref) {
  const fields = new URLSearchParams()
  if (ref.conversation) fields.set('conversation', ref.conversation)
  for (const key of ['claimId', 'claimVersion', 'documentId', 'documentVersion', 'anchorId']) {
    if (ref[key] != null && ref[key] !== '') fields.set(key, String(ref[key]))
  }
  fields.set('format', 'pdf')
  return '/claims/view-pdf?' + fields + (ref.anchorId ? '#nameddest=' + encodeURIComponent(ref.anchorId) : '')
}

export function pdfReference(params) {
  const ref = Object.fromEntries(params)
  const allowed = ['claimId', 'documentId', 'anchorId', 'format', 'claimVersion', 'documentVersion', 'conversation']
  if ([...params].some(([key]) => !allowed.includes(key) || params.getAll(key).length !== 1)
    || ref.format !== 'pdf' || !id.test(ref.claimId || '') || !id.test(ref.documentId || '')
    || (ref.anchorId !== undefined && !id.test(ref.anchorId))) return null
  if (ref.conversation !== undefined) {
    if (!uuid.test(ref.conversation) || !version.test(ref.claimVersion || '') || !version.test(ref.documentVersion || '') || !ref.anchorId) return null
  } else if (ref.documentVersion !== undefined || ref.claimVersion !== undefined) return null
  return ref
}

export function pdfBytesHref(ref) {
  if (!ref.conversation) return '/claims/api/media/' + ref.claimId + '/' + ref.documentId + '?format=pdf'
  const fields = new URLSearchParams()
  for (const key of ['claimId', 'claimVersion', 'documentId', 'documentVersion', 'anchorId']) fields.set(key, ref[key])
  fields.set('format', 'pdf')
  return '/claims/api/chat/source/' + ref.conversation + '?' + fields
}

export function openPdfDialog(event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  const link = event.currentTarget
  const dialog = document.createElement('dialog')
  if (!dialog.showModal) return
  event.preventDefault()
  const style = document.createElement('link')
  style.rel = 'stylesheet'
  style.href = '/claims/assets/claim-pdf.css'
  if (!document.head.querySelector('link[href="/claims/assets/claim-pdf.css"]')) document.head.append(style)
  dialog.className = 'claims-pdf-dialog'
  dialog.setAttribute('aria-label', 'Claim PDF')
  const frame = document.createElement('iframe')
  frame.title = 'Claim PDF viewer'
  frame.src = link.href
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Close PDF'
  close.onclick = () => dialog.close()
  dialog.addEventListener('close', () => { dialog.remove(); if (link.isConnected) link.focus() }, { once: true })
  dialog.append(close, frame)
  document.body.append(dialog)
  dialog.showModal()
}
