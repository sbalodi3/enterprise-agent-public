// All portfolio records, citations and operations are resolved by the signed-in department service.
const departments = {
  legal: { title: 'Legal Matters', queue: 'Matter queue', singular: 'matter', plural: 'matters', sources: 'Matter file',
    portfolioQuestion: 'Which counsel requests are missing a source?', question: 'Prepare a chronology and flag what counsel should verify.' },
  finance: { title: 'Finance Billing Review', queue: 'Billing exceptions', singular: 'exception', plural: 'exceptions', sources: 'Billing file',
    portfolioQuestion: 'Which billing exceptions need review?', question: 'What explains this variance?' },
}
const enc = encodeURIComponent
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const dollars = cents => money.format(cents / 100)
const delta = cents => (cents > 0 ? '+' : '') + dollars(cents)
const date = value => {
  if (!value) return 'Unscheduled'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(parsed)
}
const dueDate = value => value ? new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
}).format(new Date(value)) : 'Unscheduled'
const words = value => String(value || '').replaceAll('_', ' ')
function el(tag, cls, ...content) {
  const element = document.createElement(tag)
  if (cls) element.className = cls
  element.append(...content.filter(value => value !== undefined && value !== null && value !== false))
  return element
}
function button(label, action, cls = 'dp-btn', name = label) {
  const element = el('button', cls, label)
  element.type = 'button'
  element.setAttribute('aria-label', name)
  element.addEventListener('click', action)
  return element
}
function heading(title, secondary) {
  return el('div', 'dp-subhead', el('h3', '', title), secondary && el('span', 'dp-meta', secondary))
}
function summary(label, value) {
  return el('div', 'dp-metric', el('span', 'dp-meta', label), el('strong', '', value))
}
const stateLabels = { queued: 'Sending to Legal', awaiting_legal: 'Awaiting Legal', reply_queued: 'Returning to Finance', completed: 'Answer received' }

export function mountDepartmentPortfolio(screen, { department, identity, csrf, resume, onOpenChat }) {
  const config = departments[department]
  const stop = new AbortController()
  const assets = el('link')
  assets.rel = 'stylesheet'
  assets.href = new URL('./portfolios.css', import.meta.url).href
  screen.classList.add('dp-screen', 'dp-' + department)
  const frame = el('div', 'dp-frame')
  const main = el('section', 'dp-work')
  const assistant = el('aside', 'dp-assistant')
  assistant.setAttribute('aria-label', 'Department agent')
  const layer = el('dialog', 'dp-dialog')
  frame.append(main, assistant)
  screen.replaceChildren(assets, frame, layer)
  const initial = resume ? resume.read(identity.subject) : new URL(location.href).searchParams
  const base = '/claims/api/departments/' + enc(department)
  const legal = department === 'legal'
  let portfolio, detail, selected = initial.get('record') || null
  let inbox = initial.get('queue') === 'inbox', sort = 'priority', highlightVariance = false
  let mail = [], asking = !onOpenChat && initial.get('assistant') === 'open', turns = [], question = '', answerError = ''
  let busy = false, sending = false, status = '', alert = '', generation = 0, scopeVersion = 0, historyVersion = 0
  let currentDialog = null, signature = '', scopeSnapshot = null, identityLost = false
  const selectedPath = id => '/records/' + enc(id)
  const askPath = () => (selected ? selectedPath(selected) : '') + '/ask'

  async function request(path, body) {
    const response = await fetch(path.startsWith('/auth/') ? path : base + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: stop.signal,
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'X-CSRF-Token': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      let result
      try { result = await response.json() } catch { /* The gateway can return an empty error. */ }
      const error = new Error(result?.message || words(result?.error?.code || result?.error || result?.code) || 'Request failed (' + response.status + ').')
      error.status = response.status
      throw error
    }
    return response.status === 204 ? null : response.json()
  }
  function updateLink() {
    const next = new URL(location.href)
    for (const [key, value] of Object.entries({ record: selected, queue: inbox ? 'inbox' : null, assistant: asking ? 'open' : null })) {
      if (value) next.searchParams.set(key, value)
      else next.searchParams.delete(key)
    }
    if (resume) { resume.save(identity.subject, next.searchParams); return }
    if (next.href !== location.href) history.replaceState(history.state, '', next)
  }
  function clearAnswer() {
    scopeVersion++
    historyVersion++
    turns = []
    question = ''
    answerError = ''
    sending = false
  }
  function report(error) {
    if (stop.signal.aborted) return
    const reroute = error.status === 404 && selected
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      generation++
      portfolio = null
      mail = []
      signature = ''
      scopeSnapshot = null
      closeDialog()
      detail = null
      selected = null
      clearAnswer()
      if (error.status !== 404) {
        identityLost = true
        asking = false
      }
    }
    alert = error.message
    updateLink()
    render()
    if (reroute) void refresh()
  }
  async function refresh({ silent = false } = {}) {
    if (identityLost || stop.signal.aborted) return
    const turn = ++generation, id = selected
    try {
      const [me, list, record] = await Promise.all([
        request('/auth/me'), request('/records'), id ? request(selectedPath(id)) : null,
      ])
      if (turn !== generation || stop.signal.aborted) return
      if (['subject', 'principalId', 'tenantId'].some(key => me.user[key] !== identity[key]) ||
          (me.department || me.user.department) !== department) {
        const expired = new Error('The signed-in employee changed. Reopen the Workbench.')
        expired.status = 403
        throw expired
      }
      const next = JSON.stringify([list, record])
      if (silent && signature === next) return
      signature = next
      const recordsInScope = record ? [record] : list.items
      const revisions = recordsInScope.map(row => [row.id, row.version, row.owner, row.sourceVersions])
        .sort((a, b) => a[0].localeCompare(b[0]))
      const nextScope = JSON.stringify([id, revisions])
      if (scopeSnapshot !== null && scopeSnapshot !== nextScope) {
        clearAnswer()
        if (currentDialog) closeDialog()
      }
      scopeSnapshot = nextScope
      portfolio = list
      mail = list.mail
      detail = record
      render()
      if (asking && !sending) void loadHistory()
    } catch (err) {
      if (turn === generation && !stop.signal.aborted) report(err)
    }
  }
  async function openRecord(id) {
    if (selected !== id) {
      scopeSnapshot = null
      clearAnswer()
      detail = null
      highlightVariance = false
    }
    selected = id
    status = ''
    alert = ''
    updateLink()
    render()
    await refresh()
  }
  function chooseQueue(next) {
    inbox = next
    updateLink()
    render()
    void refresh({ silent: true })
  }
  function closeDialog() {
    if (layer.open) layer.close()
    currentDialog = null
    layer.replaceChildren()
  }
  function dialog(title) {
    closeDialog()
    const name = el('h2', '', title)
    name.id = 'dp-dialog-title'
    const close = button('Close', closeDialog, 'dp-btn dp-subtle')
    layer.setAttribute('aria-labelledby', name.id)
    layer.append(el('header', 'dp-modal-head', name, close))
    const body = el('div', 'dp-modal-body')
    layer.append(body)
    layer.showModal()
    close.focus()
    return body
  }
  layer.addEventListener('cancel', event => { event.preventDefault(); closeDialog() })
  async function openSource(recordId, sourceId, anchorId, version) {
    const token = Symbol()
    const body = dialog('Source document')
    currentDialog = token
    body.append(el('p', 'dp-meta', 'Opening source…'))
    try {
      const sourcePath = selectedPath(recordId) + '/sources/' + enc(sourceId)
      const source = await request(sourcePath + (version == null ? '' : '?version=' + enc(version)))
      if (currentDialog !== token || stop.signal.aborted) return
      if (version != null && source.version !== version) {
        const stale = new Error('This source version is no longer available. Reopen the current record.')
        stale.status = 409
        throw stale
      }
      if (anchorId && !source.passages.some(p => p.id === anchorId)) throw Error('The cited passage is unavailable.')
      const pdf = el('a', 'dp-btn', 'Open PDF')
      pdf.target = '_blank'
      pdf.rel = 'noopener noreferrer'
      pdf.href = base + sourcePath + '?version=' + enc(source.version) + '&format=pdf' +
        (anchorId ? '#nameddest=' + enc(anchorId) : '')
      body.replaceChildren(el('div', 'dp-subhead', el('div', 'dp-meta', recordId + ' · Version ' + source.version), pdf),
        el('h3', '', source.title))
      for (const passage of source.passages) {
        const entry = el('section', 'dp-passage' + (passage.id === anchorId ? ' dp-marked' : ''),
          el('strong', '', passage.label), el('p', '', passage.text))
        body.append(entry)
      }
      body.querySelector('.dp-marked')?.scrollIntoView({ block: 'nearest' })
    } catch (err) {
      if (currentDialog !== token || stop.signal.aborted) return
      if (err.status === 409) {
        closeDialog()
        report(err)
        void refresh()
      } else if (err.status === 401 || err.status === 403 || err.status === 404) report(err)
      else body.replaceChildren(el('p', 'dp-error', err.message))
    }
  }
  function sourceButton(source, recordId, anchorId, label = source.title) {
    return button(label, () => void openSource(recordId, source.id, anchorId, source.version), 'dp-link')
  }
  function confirmAction(action) {
    const record = detail
    const idempotency = crypto.randomUUID()
    const body = dialog(action.label)
    currentDialog = idempotency
    const caption = el('p', 'dp-meta', record.id + ' · Version ' + record.version)
    const approved = el('div', 'dp-approval', el('span', 'dp-label', 'Approval preview'),
      el('p', '', action.preview), action.recipient && el('p', 'dp-meta', 'To ' + action.recipient))
    if (action.filing) {
      approved.append(el('strong', '', action.filing.title))
      for (const field of action.filing.fields) {
        approved.append(el('p', '', el('strong', '', field.label + ' · '), String(field.value)))
      }
    }
    for (const id of action.sourceIds || []) {
      const source = record.sources.find(s => s.id === id)
      if (source) approved.append(el('small', 'dp-meta', source.title + ' · v' + source.version))
    }
    const error = el('p', 'dp-error')
    error.setAttribute('role', 'alert')
    const approve = button('Confirm ' + action.label.toLowerCase(), async () => {
      if (busy) return
      busy = true
      approve.disabled = true
      error.textContent = ''
      try {
        await request(selectedPath(record.id) + '/actions/' + enc(action.id), {
          expectedVersion: record.version, requestId: idempotency,
        })
        if (stop.signal.aborted) return
        closeDialog()
        status = 'Recorded · ' + action.label
        alert = ''
        await refresh()
      } catch (err) {
        if (stop.signal.aborted) return
        if ([401, 403, 404, 409].includes(err.status)) {
          closeDialog()
          report(err)
          await refresh()
        } else error.textContent = err.message + ' Retry to check this same request.'
      } finally {
        busy = false
        approve.disabled = false
      }
    }, 'dp-btn dp-primary')
    body.append(caption, approved, error, el('div', 'dp-actions',
      button('Cancel', closeDialog), approve))
  }
  function renderQueue() {
    const list = el('section', 'dp-queue')
    list.setAttribute('aria-label', inbox ? 'Department inbox' : config.queue)
    const items = [...(portfolio?.items || [])]
    if (inbox) {
      list.append(heading('Inbox', String(mail.length)))
      if (!mail.length) list.append(el('p', 'dp-muted-block', 'No messages in your portfolio inbox.'))
      for (const entry of mail) {
        const b = button('', () => void openRecord(entry.recordId), 'dp-record',
          'Open message ' + entry.title)
        b.append(el('small', 'dp-label', entry.recordId + ' · ' + date(entry.at)), el('strong', '', entry.title), el('span', 'dp-meta', entry.summary))
        list.append(b)
      }
    } else {
      const sortBy = el('select', 'dp-sort')
      sortBy.setAttribute('aria-label', 'Sort records')
      for (const [key, label] of [['priority', 'Priority'], ['due', 'Due date'], ...(legal ? [] : [['variance', 'Largest variance']])]) {
        const option = el('option', '', label)
        option.value = key
        option.selected = key === sort
        sortBy.append(option)
      }
      sortBy.onchange = () => { sort = sortBy.value; render() }
      list.append(el('header', 'dp-subhead', el('h3', '', config.queue), sortBy))
      if (sort === 'priority') {
        const order = { High: 0, Normal: 1, Low: 2 }
        items.sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3) || String(a.dueAt || 'z').localeCompare(b.dueAt || 'z'))
      }
      if (sort === 'due') items.sort((a, b) => String(a.dueAt || 'z').localeCompare(b.dueAt || 'z'))
      if (sort === 'variance') items.sort((a, b) => Math.abs(b.varianceCents || 0) - Math.abs(a.varianceCents || 0))
      for (const item of items) {
        const b = button('', () => void openRecord(item.id), 'dp-record', 'Open ' + item.id + ' ' + item.title)
        b.setAttribute('aria-pressed', String(item.id === selected))
        b.append(el('div', 'dp-record-line', el('small', 'dp-label', item.id), el('small', 'dp-status', words(item.status))),
          el('strong', '', item.title), el('span', 'dp-meta', item.account),
          el('div', 'dp-record-line', el('small', 'dp-meta', 'Due ' + dueDate(item.dueAt)),
            !legal && Number.isInteger(item.varianceCents) && el('small', 'dp-amount', delta(item.varianceCents))))
        list.append(b)
      }
    }
    return list
  }
  function renderLegal(record) {
    const section = el('section', 'dp-section')
    if (record.chronology?.length) {
      section.append(heading('Evidence chronology'))
      const timeline = el('ol', 'dp-timeline')
      for (const event of record.chronology) {
        const src = record.sources.find(s => s.id === event.sourceId)
        timeline.append(el('li', '', el('time', 'dp-amount', date(event.date)), el('div', '',
          el('p', '', event.label), src && sourceButton(src, record.id, event.anchorId))))
      }
      section.append(timeline)
    }
    if (record.checklist?.length) {
      section.append(heading('Packet checklist'))
      const checks = el('ul', 'dp-checklist')
      for (const item of record.checklist) checks.append(el('li', '', el('span', item.complete ? 'dp-check' : 'dp-pending', item.complete ? 'Included' : 'Pending'), item.label))
      section.append(checks)
    }
    return section
  }
  function renderFinance(record) {
    const recon = record.reconciliation
    if (!recon) return el('p', 'dp-muted-block', record.reason)
    const section = el('section', 'dp-section', heading('Billing reconciliation'))
    const toggle = button('', () => { highlightVariance = !highlightVariance; render() }, 'dp-metric dp-variance', 'Highlight variance ' + delta(recon.varianceCents))
    toggle.setAttribute('aria-pressed', String(highlightVariance))
    toggle.append(el('span', 'dp-meta', 'Variance'), el('strong', '', delta(recon.varianceCents)))
    section.append(el('div', 'dp-figures', summary('Supplier invoice', dollars(recon.invoiceCents)), summary('Staged client bill', dollars(recon.stagedCents)), toggle))
    const references = new Map()
    for (const row of recon.stagedRows) references.set(row.reference, (references.get(row.reference) || 0) + 1)
    const repeated = new Set([...references].filter(([, count]) => count > 1).map(([ref]) => ref))
    const lineTable = el('table', 'dp-lines')
    const header = el('tr', '', ...['Source', 'Line / reference', 'Amount'].map(label => el('th', '', label)))
    lineTable.append(el('thead', '', header))
    const rows = el('tbody')
    for (const [origin, values] of [['Invoice', recon.invoiceRows], ['Staged', recon.stagedRows]]) {
      for (const row of values) {
        const source = record.sources.find(s => s.id === row.sourceId)
        rows.append(el('tr', highlightVariance && repeated.has(row.reference) ? 'dp-highlight' : '',
          el('td', 'dp-meta', origin), el('td', '', source ? sourceButton(source, record.id, row.anchorId, row.label) : row.label,
            el('small', 'dp-meta', row.reference)), el('td', 'dp-amount', dollars(row.cents))))
      }
    }
    lineTable.append(rows)
    section.append(lineTable)
    if (highlightVariance) section.append(el('p', 'dp-note', repeated.size
      ? 'The highlighted references appear more than once in the staged bill. Review the source lines before deciding on a correction.'
      : 'Compare the cited invoice and staged lines to verify the variance.'))
    return section
  }
  function renderDetail() {
    const pane = el('article', 'dp-detail')
    pane.setAttribute('aria-label', 'Selected record')
    if (!detail) {
      if (selected || !portfolio?.items.length) {
        pane.append(el('div', 'dp-empty', el('h2', '', selected ? 'Opening record…' : 'No assigned records')))
        return pane
      }
      const items = portfolio.items
      const next = [...items].sort((a, b) => String(a.dueAt || 'z').localeCompare(b.dueAt || 'z'))[0]
      const figures = legal ? [
        summary('Assigned matters', items.length),
        summary('Awaiting source', items.filter(item => item.status === 'Awaiting source').length),
        summary('Ready for review', items.filter(item => item.status === 'Ready for review').length),
      ] : [
        summary('Billing exceptions', items.length),
        summary('Above invoice', items.filter(item => item.varianceCents > 0).length),
        summary('Below invoice', items.filter(item => item.varianceCents < 0).length),
      ]
      pane.append(el('header', 'dp-detail-head', el('div', 'dp-label', date(portfolio.asOf)), el('h2', '', 'Portfolio overview')),
        el('section', 'dp-section', el('div', 'dp-figures', ...figures)),
        el('section', 'dp-section', heading('Next due', dueDate(next.dueAt)), el('strong', '', next.id + ' · ' + next.title),
          el('p', '', next.reason), el('div', 'dp-actions', button('Review next due', () => void openRecord(next.id), 'dp-btn dp-primary'))))
      return pane
    }
    const d = detail
    pane.append(el('header', 'dp-detail-head',
      el('div', 'dp-record-line', el('span', 'dp-label', d.id), el('small', 'dp-status', words(d.status))),
      el('h2', '', d.title), el('p', 'dp-meta', [d.account, d.linkedClaimId, 'Due ' + dueDate(d.dueAt)].filter(Boolean).join(' · '))),
      el('div', 'dp-next', el('span', 'dp-label', 'Next action'), el('p', '', d.nextAction), d.reason && el('small', 'dp-meta', d.reason),
        d.actions?.length ? el('div', 'dp-actions dp-next-actions', ...d.actions.map((action, i) =>
          button(action.label, () => confirmAction(action), 'dp-btn' + (i === 0 ? ' dp-primary' : '')))) : null),
      legal ? renderLegal(d) : renderFinance(d))
    if (d.referrals?.length || d.referral) {
      const handoffs = el('section', 'dp-section', heading('Interdepartmental handoff'))
      for (const handoff of d.referrals?.length ? d.referrals : [d.referral]) {
        const shareable = d.sources.find(source => source.id === handoff.sourceId)
        handoffs.append(el('div', 'dp-transfer', el('div', 'dp-subhead', el('strong', '', 'Finance → Legal'),
          el('small', 'dp-status', stateLabels[handoff.state] || words(handoff.state))),
          el('p', '', handoff.question), handoff.answer && el('p', '', handoff.answer),
          handoff.reference && el('small', 'dp-meta', 'Shared reference · ' + handoff.reference),
          shareable && sourceButton(shareable, d.id, 'disposition', 'View approved reply'),
          el('small', 'dp-meta', 'A2A task · ' + handoff.id)))
      }
      pane.append(handoffs)
    }
    pane.append(el('section', 'dp-section', heading(config.sources, d.sources.length + ' sources'),
      el('div', 'dp-files', ...d.sources.map(src => sourceButton(src, d.id, null)))))
    if (d.receipts?.length) {
      const receipts = el('section', 'dp-section', heading('Receipts', String(d.receipts.length)))
      for (const receipt of d.receipts) {
        const entry = el('div', 'dp-receipt', el('strong', '', receipt.summary), el('small', 'dp-meta', receipt.id + ' · ' + date(receipt.at)))
        const destination = receipt.destination
        if (destination) {
          const body = el('div', 'dp-destination', el('small', 'dp-label', destination.system), el('strong', '', destination.title),
            el('p', 'dp-meta', destination.id + ' · ' + date(destination.at)))
          for (const field of destination.fields) body.append(el('p', '', el('strong', '', field.label + ' · '), String(field.value)))
          const evidence = el('div', 'dp-files')
          for (const ref of destination.sources) {
            const source = d.sources.find(item => item.id === ref.id && item.version === ref.version)
            if (source) evidence.append(sourceButton(source, d.id, null, source.title + ' · v' + ref.version))
            else evidence.append(el('span', 'dp-meta', ref.id + ' · v' + ref.version))
          }
          body.append(evidence)
          entry.append(el('details', 'dp-receipt-details', el('summary', '', 'View destination record'), body))
        }
        receipts.append(entry)
      }
      pane.append(receipts)
    }
    return pane
  }
  async function loadHistory() {
    if (!asking || stop.signal.aborted) return
    const token = ++historyVersion
    try {
      const response = await request(askPath())
      if (token !== historyVersion || !asking || stop.signal.aborted || sending) return
      turns = response.items
      renderAssistant()
    } catch (err) {
      if (token !== historyVersion || stop.signal.aborted) return
      if (err.status === 401 || err.status === 403 || err.status === 404) report(err)
      else { answerError = err.message; renderAssistant() }
    }
  }
  async function ask(value) {
    if (sending || !value.trim()) return
    const token = scopeVersion
    const submitted = value.trim()
    historyVersion++
    sending = true
    answerError = ''
    question = submitted
    renderAssistant()
    try {
      const answer = await request(askPath(), { question: submitted })
      if (scopeVersion !== token || stop.signal.aborted) return
      turns = [...turns, { question: submitted, answer }]
      question = ''
    } catch (err) {
      if (scopeVersion !== token || stop.signal.aborted) return
      if (err.status === 401 || err.status === 403 || err.status === 404) report(err)
      else answerError = err.message
    } finally {
      if (scopeVersion === token && !stop.signal.aborted) {
        sending = false
        renderAssistant()
        assistant.querySelector('textarea')?.focus({ preventScroll: true })
        const feed = assistant.querySelector('.dp-chat-feed')
        if (feed) feed.scrollTop = feed.scrollHeight
      }
    }
  }
  function toggleAgent(value) {
    if (value && onOpenChat) { void onOpenChat({ record: selected }); return }
    if (value && !asking) turns = []
    asking = value
    updateLink()
    render()
    if (value) {
      if (!sending) void loadHistory()
      assistant.querySelector('textarea')?.focus()
    } else main.querySelector('[data-agent]')?.focus()
  }
  function renderAssistant() {
    assistant.hidden = !asking
    frame.classList.toggle('dp-with-agent', asking)
    if (!asking) return
    const active = assistant.contains(document.activeElement) ? document.activeElement : null
    const start = active?.selectionStart, end = active?.selectionEnd
    const previousScroll = assistant.querySelector('.dp-chat-feed')?.scrollTop || 0
    const feed = el('div', 'dp-chat-feed')
    const scope = detail?.id || selected || 'My portfolio'
    assistant.replaceChildren(el('header', 'dp-subhead dp-agent-head', el('div', '', el('small', 'dp-label', scope), el('h2', '', legal ? 'Legal agent' : 'Finance agent')),
      button('Collapse', () => toggleAgent(false), 'dp-btn dp-subtle')), feed)
    if (!turns.length && !sending) {
      const prompt = selected ? config.question : config.portfolioQuestion
      feed.append(el('p', 'dp-meta', 'Ask about ' + (selected ? 'the selected record and its sources.' : 'your authorized portfolio.')),
        button(prompt, () => void ask(prompt), 'dp-prompt'))
    }
    for (const turn of turns) {
      const answer = turn.answer
      if (!answer) continue
      const mode = answer.mode === 'live' ? (answer.model || 'Local model') : 'Verified record lookup'
      const response = el('section', 'dp-answer', el('small', 'dp-label', mode), el('p', '', answer.text))
      if (answer.sources?.length) {
        const sources = el('div', 'dp-files')
        for (const ref of answer.sources) sources.append(button(ref.title, () => void openSource(ref.recordId, ref.sourceId, ref.anchorId, ref.version), 'dp-link'))
        response.append(sources)
      }
      feed.append(el('p', 'dp-question', turn.question), response)
    }
    if (sending) feed.append(el('p', 'dp-meta', 'Checking the supporting records…'))
    if (answerError) {
      const failure = el('p', 'dp-error', answerError)
      failure.setAttribute('role', 'alert')
      feed.append(failure)
    }
    const input = el('textarea', 'dp-input')
    input.setAttribute('aria-label', 'Question for the ' + department + ' agent')
    input.rows = 3
    input.maxLength = 1000
    input.placeholder = 'Ask about ' + scope.toLowerCase() + '…'
    input.value = question
    input.disabled = sending
    const send = button('Send', () => void ask(input.value), 'dp-btn dp-primary')
    send.disabled = sending || !question.trim()
    input.oninput = () => { question = input.value; send.disabled = !question.trim() || sending }
    input.onkeydown = event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask(input.value) }
      if (event.key === 'Escape') { event.preventDefault(); toggleAgent(false) }
    }
    assistant.append(el('div', 'dp-compose', input, el('div', 'dp-actions', send)))
    feed.scrollTop = previousScroll
    if (active?.tagName === 'TEXTAREA' && !sending) {
      input.focus({ preventScroll: true })
      if (Number.isInteger(start) && Number.isInteger(end)) input.setSelectionRange(start, end)
    }
  }
  async function signOut() {
    try {
      await request('/auth/logout', {})
      location.replace('/auth/signed-out')
    } catch (err) { report(err) }
  }
  function render() {
    const previous = main.contains(document.activeElement) ? document.activeElement?.getAttribute('aria-label') : null
    const title = el('div', 'dp-title', el('h1', '', config.title),
      el('p', 'dp-meta', identity.displayName + ' · ' + (legal ? 'Legal operations' : 'Client finance') + ' · Synthetic portfolio'))
    const askButton = button('Ask agent', () => toggleAgent(!asking), 'dp-btn dp-primary')
    askButton.dataset.agent = ''
    askButton.setAttribute('aria-expanded', String(asking))
    main.replaceChildren(el('header', 'dp-header', title, el('div', 'dp-actions', askButton,
      button('Refresh', () => { alert = ''; void refresh() }), button('Sign out', () => void signOut(), 'dp-btn dp-subtle'))))
    if (alert || status) {
      const message = el('div', alert ? 'dp-error' : 'dp-note', alert || status)
      message.setAttribute('role', alert ? 'alert' : 'status')
      main.append(message)
    }
    if (!portfolio) {
      main.append(el('p', 'dp-muted-block', identityLost ? 'Your session no longer has access to this portfolio.' : 'Loading portfolio…'))
      if (identityLost) {
        const link = el('a', 'dp-btn', 'Return to sign in')
        link.href = '/open-app'
        main.append(link)
      }
      renderAssistant()
      return
    }
    const nav = el('nav', 'dp-nav')
    nav.setAttribute('aria-label', 'Portfolio views')
    for (const [value, label, count] of [[false, 'My portfolio', portfolio.items.length], [true, 'Inbox', mail.length]]) {
      const b = button(label, () => chooseQueue(value), 'dp-nav-item')
      b.append(el('small', '', String(count)))
      b.setAttribute('aria-current', inbox === value ? 'page' : 'false')
      nav.append(b)
    }
    if (selected && asking) nav.append(button('Ask about my portfolio', () => void openRecord(null), 'dp-link'))
    main.append(nav, el('div', 'dp-grid', renderQueue(), renderDetail()))
    renderAssistant()
    if (previous) [...main.querySelectorAll('button,select')].find(x => x.getAttribute('aria-label') === previous)?.focus({ preventScroll: true })
  }
  const refreshVisible = () => {
    if (!document.hidden && !busy && !identityLost) void refresh({ silent: true })
  }
  window.addEventListener('focus', refreshVisible)
  const poll = setInterval(refreshVisible, 7000)
  render()
  void refresh()
  return () => {
    stop.abort()
    clearInterval(poll)
    window.removeEventListener('focus', refreshVisible)
    closeDialog()
    screen.classList.remove('dp-screen', 'dp-' + department)
    screen.replaceChildren()
  }
}
