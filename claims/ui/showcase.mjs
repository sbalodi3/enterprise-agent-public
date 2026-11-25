// Presentation for connected synthetic records. Every consequential action goes back to the work API.
import { pdfViewerHref, openPdfDialog } from './pdf-link.mjs'
const enc = encodeURIComponent
const media = (item, id, format) => '/claims/api/media/' + enc(item) + '/' + enc(id) + '?format=' + format
const duration = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')
export function showDocument(parent, doc, activeAnchor, { node }) {
  const paper = node('article', 'cw-paper')
  paper.append(
    node('small', 'cw-id', 'SYNTHETIC CLAIM DOCUMENT'),
    node('h3', '', doc.title),
    node('small', 'cw-meta', doc.source + ' · ' + doc.itemId + ' · Version ' + doc.version),
  )
  const download = node('a', 'cw-source-link', 'Open PDF')
  download.href = pdfViewerHref({ claimId: doc.itemId, documentId: doc.id, anchorId: activeAnchor })
  download.onclick = openPdfDialog
  paper.append(download)
  for (const a of doc.anchors) {
    const block = node('section', 'cw-excerpt' + (a.id === activeAnchor ? ' cw-cited' : ''))
    block.append(node('strong', '', a.label), node('p', '', a.text))
    paper.append(block)
  }
  parent.append(paper)
}
export function showIntake(main, detail, ui, state) {
  const { node, box, button, field } = ui,
    data = detail.showcase,
    item = detail.item
  const review = box(main, 'Intake Review')
  const doc = data.documents.find((d) => d.id === 'IN-201-call')
  if (!doc) {
    review.append(node('p', '', item.reason))
    return
  }
  const audio = node('audio', 'cw-player')
  audio.controls = true
  audio.preload = 'metadata'
  audio.src = media(item.id, doc.id, 'audio')
  audio.setAttribute('aria-label', 'Synthetic missed call recording')
  review.append(node('small', 'cw-meta', 'Recorded demonstration call · Synthetic voices'), audio)
  const transcript = node('div', 'cw-transcript')
  for (const a of doc.anchors) {
    const row = node('div', 'cw-utterance'),
      seek = node('button', 'cw-seek', duration(a.startSeconds))
    seek.type = 'button'
    seek.setAttribute('aria-label', 'Play ' + a.label + ' at ' + duration(a.startSeconds))
    seek.onclick = () => {
      audio.currentTime = a.startSeconds
      audio.play().catch(() => {})
    }
    const speech = node('div')
    speech.append(node('small', 'cw-meta', a.label), node('p', '', a.text))
    row.append(seek, speech)
    transcript.append(row)
  }
  review.append(transcript)
  if (data.filed && !data.filedClaimId) {
    review.append(node('p', 'cw-meta', 'Transcript filed.'))
    return
  }
  if (data.filedClaimId) {
    review.append(
      button('Open filed claim ' + data.filedClaimId, () => state.open(data.filedClaimId), 'cw-primary'),
    )
    return
  }
  const match = box(main, 'Match to an existing claim')
  const candidates = node('div', 'cw-candidates')
  const select = node('select', 'cw-control')
  select.id = 'cw-match'
  const option = (v, label) => {
    const o = node('option', '', label)
    o.value = v
    select.append(o)
  }
  option('', 'Select a claim')
  for (const c of data.candidates) {
    const card = node('article', 'cw-candidate')
    card.append(
      node('small', 'cw-id', c.id),
      node('strong', '', c.title),
      node('p', '', c.claimant + ' · ' + c.employer),
      node('p', 'cw-meta', c.site + ' · ' + c.incidentDate),
    )
    const report = node('a', 'cw-source-link', 'Read ' + c.id + ' report')
    report.href = pdfViewerHref({ claimId: c.id, documentId: c.id + '-report' })
    report.onclick = openPdfDialog
    card.append(report)
    candidates.append(card)
    option(c.id, c.id + ' · ' + c.site)
  }
  select.value = state.get('target')
  select.onchange = () => state.keep('target', select.value)
  const citation = node('select', 'cw-control')
  for (const a of doc.anchors) {
    const o = node('option', '', duration(a.startSeconds) + ' · ' + a.text)
    o.value = a.id
    citation.append(o)
  }
  citation.value = state.get('citation') || 'worksite'
  citation.onchange = () => state.keep('citation', citation.value)
  match.append(candidates)
  if (detail.canAct && data.candidates.length) {
    match.append(
      field('Target claim', select),
      field('Transcript citation', citation),
      button(
        'Prepare filing',
        async () => {
          if (!select.value) throw Error('Choose the claim that matches the caller’s worksite and report.')
          await state.prepare({
            expectedVersion: item.version,
            action: 'file_intake_transcript',
            targetClaimId: select.value,
            evidenceId: doc.id,
            anchorId: citation.value,
          })
        },
        'cw-primary',
      ),
    )
  }
}
export function showJuris(main, record, { node, box }) {
  const s = box(main, 'Mock JURIS record')
  s.append(
    node('small', 'cw-id', record.id + ' · Source revision ' + record.revision),
    node('h2', '', record.claimant || record.insured),
    node('p', 'cw-meta', [record.employer || record.client,record.site || record.office,record.incidentDate].filter(Boolean).join(' · ')),
  )
  if (record.externalClaimNumber) {
    const handling=box(s,'Current handling')
    handling.append(node('p','',record.handlingPriority+' · '+(record.nextHandlingInstruction || 'No handling instruction')))
    const notes=box(s,'Claim notes')
    for (const n of record.notes) notes.append(node('p','',n.category+' · '+n.text+' · '+n.source))
    const diaries=box(s,'Diaries')
    for (const d of record.diaries) diaries.append(node('p','',[d.status,d.dueAt,d.owner,d.purpose,d.completion].filter(Boolean).join(' · ')))
  }
  const wage = box(s, 'Wage evidence')
  wage.append(node('p', '', record.wageEvidence?.quote || 'No wage statement filed.'))
  for (const passage of record.wageEvidence?.filing || []) {
    if (passage !== record.wageEvidence.quote) wage.append(node('p','',passage))
  }
  const files = box(s, 'Filed transcripts')
  if (!record.intakeTranscripts?.length) files.append(node('p', 'cw-meta', 'No intake transcript filed.'))
  for (const f of record.intakeTranscripts || [])
    files.append(node('strong', '', f.documentId), node('p', '', f.quote))
  const receipts = box(s, 'Destination receipts')
  if (!record.receipts?.length) receipts.append(node('p', 'cw-meta', 'No commands applied.'))
  for (const r of record.receipts || [])
    receipts.append(
      node('strong', '', r.receiptId),
      node('p', 'cw-meta', 'Revision ' + r.previousRevision + ' → ' + r.revision + ' · ' + r.type),
    )
}
