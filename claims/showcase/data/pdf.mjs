// Small, offline PDF writer for the controlled, English-language showcase sources.
// The browser's accessible text reader and PDF use the same versioned anchors.
const width = 612
const height = 792
const margin = 52
const ink = '0.10 0.16 0.20'
const muted = '0.26 0.33 0.38'
const accent = '0.04 0.37 0.36'
const paper = '0.96 0.97 0.96'
const pdfString = (value) =>
  `(${String(value)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '-')
    .replace(/[()\\]/g, '\\$&')})`
const text = (x, y, value, size = 11, font = 'F1', color = ink) =>
  `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x} ${y} Tm ${pdfString(value)} Tj ET\n`
const rule = (x, y, length) => `0.80 0.85 0.85 RG 0.6 w ${x} ${y} m ${x + length} ${y} l S\n`
function wrap(content, limit) {
  const lines = []
  let line = ''
  for (const token of content.split(/\s+/)) {
    for (let offset = 0; offset < token.length; offset += limit) {
      const piece = token.slice(offset, offset + limit)
      if (line && line.length + piece.length + 1 > limit) {
        lines.push(line)
        line = ''
      }
      line += line ? ` ${piece}` : piece
    }
  }
  if (line) lines.push(line)
  return lines
}
function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

export function renderDocumentPdf(doc) {
  const pages = []
  const destinations = []
  let cursor
  let page
  function beginPage() {
    page = { body: '' }
    pages.push(page)
    page.body += `q ${paper} rg 0 662 ${width} 130 re f Q\n`
    page.body += `q ${accent} rg 0 ${height - 7} ${width} 7 re f Q\n`
    page.body += text(margin, 748, 'ENTERPRISE AGENT   /   SYNTHETIC ' + (doc.department || 'CLAIMS'), 9, 'F2', accent)
    page.body += text(margin, 710, doc.title, 22, 'F2')
    page.body += text(
      margin,
      685,
      `${doc.itemId}     |     ${doc.kind}     |     Version ${doc.version}`,
      10,
      'F1',
      muted,
    )
    page.body += text(margin, 633, `Source: ${doc.source}     /     ${doc.dateLabel || 'Recorded'} ${doc.asOf}`, 10, 'F1', muted)
    cursor = 587
  }
  beginPage()
  for (const a of doc.anchors) {
    const lines = wrap(a.text, 79)
    if (cursor < 112 + Math.min(lines.length, 5) * 16) beginPage()
    destinations.push({ id: a.id, page: pages.length - 1, top: cursor + 14 })
    const label = a.startSeconds == null ? a.label : `${clock(a.startSeconds)}   ${a.label}`
    page.body += text(margin, cursor, label, 12, 'F2', accent)
    cursor -= 21
    for (const line of lines) {
      if (cursor < 90) beginPage()
      page.body += text(margin, cursor, line)
      cursor -= 16
    }
    cursor -= 4
    page.body += rule(margin, cursor, width - 2 * margin)
    cursor -= 31
  }
  const objects = [
    undefined,
    undefined,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ]
  const pageRef = (n) => 5 + n * 2
  for (const [i, p] of pages.entries()) {
    p.body += text(margin, 44, 'Fictional demonstration record', 9, 'F1', muted)
    p.body += text(493, 44, `${i + 1} of ${pages.length}`, 9, 'F1', muted)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageRef(i) + 1} 0 R >>`,
    )
    objects.push(`<< /Length ${Buffer.byteLength(p.body)} >>\nstream\n${p.body}endstream`)
  }
  const names = destinations
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((d) => `${pdfString(d.id)} [${pageRef(d.page)} 0 R /XYZ null ${d.top} null]`)
    .join('\n')
  objects[0] = `<< /Type /Catalog /Lang (en-US) /Pages 2 0 R /Names << /Dests << /Names [${names}] >> >> >>`
  objects[1] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageRef(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${i + 1} 0 obj\n${obj}\nendobj\n`
  }
  const startxref = Buffer.byteLength(output)
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  output += offsets
    .slice(1)
    .map((x) => `${String(x).padStart(10, '0')} 00000 n \n`)
    .join('')
  return Buffer.from(
    `${output}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
  )
}
