import { mountActionReview } from './action-review.mjs'
import { showDocument, showIntake, showJuris } from './showcase.mjs'
import { getTimeline, mountSummary, mountTimeline } from './timeline-host.mjs'
import { businessLines, claimTitle, groupName, summaryMetrics } from './widget-format.mjs'
// The host mounts this panel under its authenticated sidebar. All content is rendered as text.
const sections = { must: 'Must act this shift', ready: 'Ready to move', waiting: 'Waiting on others' }
const tasks = {
  explain_priority: 'Explain priority',
  prepare_handoff: 'Prepare handoff',
  compare_evidence: 'Compare evidence',
  timeline: 'Summarize timeline',
}
const errors = {
  unverified_source_response:
    'The live model could not substantiate this answer. Open the evidence or run Replay for this record.',
  assistant_did_not_read_selected_source:
    'The assistant could not verify the selected source. Open the evidence or try Replay.',
  local_model_unavailable: 'The local model is unavailable. Replay is available for this record.',
}
const enc = encodeURIComponent
const allStatuses = { all: 'All claims', open: 'Open', closed: 'Closed' }
function node(tag, cls, text) {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = String(text)
  return el
}
function stamp(value) {
  if (!value) return 'No due date'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value))
}
export function mountWorkbench(root, { onChatContext, onAsk, onOpenDepartmentChat, onReady, embedded = false, resume, onSignOut } = {}) {
  const screen = node('section', 'cw-panel')
  root.append(screen)
  const stop = new AbortController()
  let unmountDepartment
  let identity,
    csrf,
    portfolio,
    inbox = [],
    tab = 'portfolio',
    selected = null,
    detail = null,
    evidence = null
  let lostAck = false,
    workflowAvailable = false
  let wageReviewEnabled = false
  let scrollToTimeline = false
  let needsLogin = false,
    busy = false,
    error = '',
    notice = '',
    assistant = null,
    simulated = false,
    shownDetail = 'overview',
    mode = 'replay'
  let showcase = false,
    docId,
    anchorId,
    juris,
    timeline,
    closeFrame,
    returnView,
    restoreLink = true
  let cmsDataset = false, adjusters = [], directoryQuery = '', directoryStatus = 'all', directoryLob = '', directoryOwner = ''
  let groupBy = 'lob', summaryData, summaryHtml, closeSummary
  let summaryStatus = 'all', summaryOwner = '', summaryLob = ''
  let portfolioPage = 0
  const isAdmin = () => identity?.roles?.includes('claims_admin')
  const ui = { node, button, box, field }
  async function setDocument(id, anchor) {
    if (!detail?.showcase?.documents.some((doc) => doc.id === id)) throw Error('Source is unavailable.')
    const doc = await request('documents/' + enc(selected) + '/' + enc(id))
    if (anchor && !doc.anchors.some((a) => a.id === anchor)) throw Error('Citation is unavailable.')
    detail.showcase.documents = detail.showcase.documents.map((d) => (d.id === id ? doc : d))
    if (shownDetail !== 'sources') returnView = shownDetail
    docId = id
    anchorId = anchor
    shownDetail = 'sources'
    if (anchor) requestAnimationFrame(() => {
      const cited = screen.querySelector('.cw-excerpt.cw-cited')
      if (cited) { cited.tabIndex = -1; cited.focus({ preventScroll: true }); cited.scrollIntoView({ block: 'nearest' }) }
    })
  }
  function updateLink() {
    if ((!showcase && !embedded) || !portfolio || restoreLink || stop.signal.aborted) return
    const url = new URL(location.href)
    for (const [k, v] of Object.entries({
      record: selected,
      view: selected && shownDetail,
      source: shownDetail === 'sources' && (docId || evidence?.id),
      anchor: shownDetail === 'sources' && anchorId,
      queue: tab !== 'portfolio' && tab,
    })) {
      if (v) url.searchParams.set(k, v)
      else url.searchParams.delete(k)
    }
    if (embedded) resume.save(identity.subject, url.searchParams)
    else history.replaceState(history.state, '', url)
  }
  const checked = new Set(),
    drafts = new Map(),
    exposed = new Set()
  let observer = null,
    ranking = 'rules',
    evaluation = null,
    sessions = null
  const key = (name) => 'cw-' + name
  const remember = (name, fallback = '') => drafts.get((selected ?? '') + ':' + name) ?? fallback
  const keep = (name, value) => drafts.set((selected ?? '') + ':' + name, value)
  function button(label, cb, cls = '', name = label) {
    const b = node('button', 'cw-btn ' + cls, label)
    b.type = 'button'
    b.dataset.focus = key(name)
    b.addEventListener('click', () => action(cb))
    return b
  }
  const authPath = path => embedded && location.pathname !== '/chat' ? path.replace('/auth/', '/desktop/workbench/') : path
  async function request(path, body) {
    const r = await fetch(path.startsWith('/auth/') ? authPath(path) : '/claims/api/' + path, {
      credentials: 'same-origin',
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: stop.signal,
    })
    if (!r.ok) {
      const data = await r.json().catch(() => ({}))
      const e = new Error(
        errors[data.code] ||
          data.message ||
          data.error?.message ||
          data.code ||
          'Request failed (' + r.status + ').',
      )
      e.status = r.status
      throw e
    }
    return r.status === 202 || r.status === 204 ? null : r.json()
  }
  async function load() {
    const me = await request('/auth/me')
    if (
      identity &&
      ['principalId', 'subject', 'tenantId'].some((field) => identity[field] !== me.user[field])
    ) {
      clearPrincipal()
    }
    needsLogin = false
    identity = me.user
    csrf = me.csrfToken
    const department = me.department || identity.department
    if (department === 'legal' || department === 'finance') {
      const { mountDepartmentPortfolio } = await import('./portfolios.mjs')
      if (!stop.signal.aborted && !unmountDepartment) {
        onChatContext?.({ enabled: false, department, subject: identity.subject, claimId: null })
        const shared = document.querySelector('meta[name="claims-shared-host"]')
        const openChat = onOpenDepartmentChat || (shared && (({ record }) => {
          location.assign(record ? '/chat?record=' + encodeURIComponent(record) : '/chat')
        }))
        unmountDepartment = mountDepartmentPortfolio(screen, { department, identity, csrf, resume: embedded && resume, onOpenChat: openChat })
      }
      return
    }
    const [m, status] = await Promise.all([request('mailbox'), request('status')])
    cmsDataset = status.cmsDataset === true
    const filters = new URLSearchParams({ ranking })
    if (cmsDataset) {
      filters.set('status', directoryStatus)
      if (directoryQuery) filters.set('q', directoryQuery)
      if (directoryLob) filters.set('lob', directoryLob)
      if (directoryOwner && isAdmin()) filters.set('ownerId', directoryOwner)
    }
    const [p, directory] = await Promise.all([
      request('portfolio?' + filters),
      cmsDataset ? request('adjusters') : null,
    ])
    adjusters = directory?.items || []
    portfolio = p
    window.dispatchEvent(new Event('claims:portfolio-refreshed'))
    inbox = m.items
    wageReviewEnabled = status.wageReview === true
    workflowAvailable = status.workflow === true
    showcase = status.showcase === true
    const link = embedded ? resume.read(identity.subject) : new URL(location.href).searchParams
    if (restoreLink && (showcase || embedded)) {
      const record = link.get('record')
      if (p.items.some(item => item.id === record) || /^(?:(?:WC|IN)-[0-9]{3}|CLM-[0-9]{6})$/.test(record || '')) selected = record
      else if (record) notice = 'This record is no longer available.'
      if (['inbox', 'must', 'ready', 'waiting', ...(cmsDataset ? ['summary'] : [])].includes(link.get('queue'))) tab = link.get('queue')
    }
    exposed.clear()
    const ids = new Set(p.items.map((i) => i.id))
    if (assistant?.batch) assistant.batch = assistant.batch.filter((r) => ids.has(r.id))
    for (const id of checked) if (!ids.has(id)) checked.delete(id)
    if (selected && !ids.has(selected) && !showcase) {
      notice = 'This record is no longer available.'
      selected = null
      resetDetail()
    }
    if (selected) {
      let latest
      try {
        latest = await request('items/' + enc(selected))
      } catch (e) {
        if (e.status !== 404 && e.status !== 403) throw e
        selected = null
        resetDetail()
        notice = 'This record is no longer available.'
        restoreLink = false
        return
      }
      if (detail && latest.item.version !== detail.item.version) {
        const view = shownDetail
        resetDetail()
        if (showcase) shownDetail = view
      }
      detail = latest
      if (restoreLink && (showcase || embedded)) {
        if (['sources', 'intake', 'reviews', 'people', 'juris'].includes(link.get('view')))
          shownDetail = link.get('view')
        const source = link.get('source')
        if (shownDetail === 'sources' && source) {
          try {
            if (showcase && detail.showcase?.documents.some(doc => doc.id === source)) await setDocument(source, link.get('anchor'))
            else if (!showcase && detail.evidence.some(item => item.id === source)) evidence = await readSource(source)
            else notice = 'This source is no longer available.'
          } catch (error) {
            if (![403, 404].includes(error.status)) throw error
            notice = 'This source is no longer available.'
          }
        }
      }
      if (shownDetail === 'juris' && latest.showcase?.capabilities?.juris === false) shownDetail = 'overview'
      if (shownDetail === 'juris' && latest.item.type === 'claim')
        juris = await request('items/' + enc(selected) + '/juris')
    }
    if (cmsDataset && tab === 'summary') await loadSummary()
    restoreLink = false
  }
  async function loadSummary() {
    summaryData = null
    if (!summaryHtml) {
      try {
        const response = await fetch('/claims/assets/portfolio-summary.widget.json', { signal: stop.signal })
        if (response.ok) summaryHtml = await response.json()
      } catch (error) { if (stop.signal.aborted) throw error }
    }
    const filters = new URLSearchParams({ groupBy, status: summaryStatus })
    if (summaryOwner && isAdmin()) filters.set('ownerId', summaryOwner)
    if (summaryLob) filters.set('lob', summaryLob)
    summaryData = await request('portfolio-summary?' + filters)
  }
  function clearPrincipal() {
    identity = null
    showcase = false
    csrf = null
    portfolio = null
    inbox = []
    selected = null
    evaluation = null
    lostAck = false
    simulated = false
    workflowAvailable = false
    tab = 'portfolio'
    cmsDataset = false
    adjusters = []
    directoryQuery = directoryOwner = directoryLob = ''
    directoryStatus = 'all'
    summaryData = null
    groupBy = 'lob'
    summaryStatus = 'all'
    summaryOwner = summaryLob = ''
    portfolioPage = 0
    checked.clear()
    drafts.clear()
    exposed.clear()
    resetDetail()
  }
  function resetDetail() {
    docId = null
    anchorId = null
    returnView = null
    juris = null
    timeline = null
    scrollToTimeline = false
    detail = null
    sessions = null
    evidence = null
    assistant = null
    shownDetail = 'overview'
  }
  async function openItem(id) {
    if (id !== selected) {
      selected = id
      resetDetail()
      // The separate sidebar can be clicked while the claim detail request is loading.
      publishChatContext()
    }
    const item = await request('items/' + enc(id))
    if (selected !== id || stop.signal.aborted) return
    detail = item
    if (!stop.signal.aborted)
      request('decisions/' + enc(portfolio.decisionSetId) + '/feedback', {
        itemId: id,
        kind: 'selected',
      }).catch(() => {})
  }
  async function action(work) {
    if (busy || stop.signal.aborted) return
    busy = true
    error = ''
    notice = ''
    screen.setAttribute('aria-busy', 'true')
    const pending = screen.querySelector('[data-progress]')
    if (pending) pending.textContent = 'Working…'
    try {
      await work()
    } catch (e) {
      if (stop.signal.aborted) return
      if (e.status === 401) { needsLogin = true; clearPrincipal() }
      if (e.status === 403 || e.status === 404) {
        resetDetail()
        selected = null
        drafts.clear()
        try {
          await load()
        } catch {
          portfolio = null
          inbox = []
        }
      }
      error = e.message || 'Unable to load this view.'
    } finally {
      busy = false
      if (!stop.signal.aborted) {
        screen.removeAttribute('aria-busy')
        render()
      }
    }
  }
  async function reload(text) {
    await load()
    notice = text
  }
  function field(label, control) {
    const l = node('label', 'cw-field')
    l.append(node('span', '', label), control)
    return l
  }
  function select(options, value, set) {
    const el = node('select', 'cw-control')
    for (const [v, t] of Object.entries(options)) {
      const o = node('option', '', t)
      o.value = v
      el.append(o)
    }
    el.value = value
    el.addEventListener('change', () => set(el.value))
    return el
  }
  function input(name, placeholder) {
    const el = node('textarea', 'cw-control')
    el.rows = 2
    el.value = remember(name)
    el.placeholder = placeholder
    el.addEventListener('input', () => keep(name, el.value))
    return el
  }
  function box(parent, title) {
    const el = node('section', 'cw-section')
    el.append(node('h3', '', title))
    parent.append(el)
    return el
  }
  function watchExposures() {
    observer?.disconnect()
    observer = null
    if (!portfolio || !('IntersectionObserver' in window)) return
    const id = portfolio.decisionSetId
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((x) => x.isIntersecting && !exposed.has(x.target.dataset.item))
          .map((x) => x.target.dataset.item)
        if (!visible.length) return
        for (const item of visible) exposed.add(item)
        request('decisions/' + enc(id) + '/exposure', { itemIds: visible }).catch(() => {
          if (portfolio?.decisionSetId === id) for (const item of visible) exposed.delete(item)
        })
      },
      { threshold: 0.25 },
    )
    for (const row of screen.querySelectorAll('[data-item]')) observer.observe(row)
  }
  function portfolioList(left) {
    if (cmsDataset) {
      const filter = node('form', 'cw-portfolio-filters')
      filter.setAttribute('aria-label', 'Filter claims')
      const search = node('input', 'cw-control')
      search.type = 'search'
      search.placeholder = 'CLM-000020'
      search.value = directoryQuery
      search.dataset.focus = key('claim-search')
      const apply = () => action(async () => { portfolioPage = 0; directoryQuery = search.value.trim(); await load() })
      filter.addEventListener('submit', event => { event.preventDefault(); void apply() })
      filter.append(field('Claim number or keywords', search))
      const go = node('button', 'cw-btn', 'Search')
      go.type = 'submit'
      filter.append(go)
      filter.append(field('Claim status', select(allStatuses, directoryStatus, v => {
        directoryStatus = v; void apply()
      })))
      filter.append(field('Line of business', select(businessLines, directoryLob, v => {
        directoryLob = v; void apply()
      })))
      if (isAdmin()) filter.append(field('Assigned adjuster', select({ '': 'All adjusters', ...Object.fromEntries(adjusters.map(a => [a.id, a.displayName])) },
        directoryOwner, v => { directoryOwner = v; void apply() })))
      left.append(filter)
    }
    if (checked.size) {
      const bar = node('div', 'cw-bulk')
      bar.append(
        node('span', '', checked.size + ' selected'),
        button(
          'Prepare handoffs',
          async () => {
            const outcomes = []
            for (const id of [...checked]) {
              const item = portfolio.items.find((x) => x.id === id)
              try {
                const res = await request('assist', {
                  itemId: id,
                  expectedVersion: item.version,
                  task: 'prepare_handoff',
                  mode,
                })
                outcomes.push({ id, text: res.text, mode: res.mode, sessionId: res.sessionId })
              } catch (e) {
                outcomes.push({ id, text: e.message, mode: 'Unavailable' })
              }
            }
            selected = null
            resetDetail()
            assistant = { batch: outcomes }
          },
          '',
          'bulk-handoff',
        ),
        ...(onAsk && checked.size > 1 && [...checked].every((id) => portfolio.items.some((item) => item.id === id && item.type === 'claim'))
          ? [button('Compare selected in Chat', () => onAsk({ kind: 'multi', claimIds: [...checked].sort() }))] : []),
        button('Clear', () => checked.clear(), 'cw-flat'),
      )
      left.append(bar)
    }
    let total = 0
    const shiftSections = showcase
      ? { must: 'Needs my action', waiting: 'Waiting on someone', ready: 'Ready for review' }
      : sections
    const inQueue = ['must', 'ready', 'waiting'].includes(tab)
    const matching = portfolio.items.filter(i => !inQueue || i.section === tab && i.lifecycle !== 'closed')
    const size = 25
    portfolioPage = Math.min(portfolioPage, Math.max(0, Math.ceil(matching.length / size) - 1))
    const visibleRows = cmsDataset ? matching.slice(portfolioPage * size, (portfolioPage + 1) * size) : matching
    if (cmsDataset && matching.length > size) {
      const nav = node('nav', 'cw-controls')
      nav.setAttribute('aria-label', 'Portfolio pages')
      const previous = button('Previous page', () => { portfolioPage-- })
      const next = button('Next page', () => { portfolioPage++ })
      previous.disabled = portfolioPage === 0
      next.disabled = (portfolioPage + 1) * size >= matching.length
      nav.append(previous, node('span', '', (portfolioPage * size + 1) + '–' + Math.min((portfolioPage + 1) * size, matching.length) + ' of ' + matching.length), next)
      left.append(nav)
    }
    const groups = cmsDataset && !inQueue ? { ...shiftSections, closed: 'Closed claims' }
      : ranking === 'due-date' && tab !== 'waiting' ? { all: 'Due date order' } : shiftSections
    for (const [section, label] of Object.entries(groups)) {
      if ((tab === 'waiting' || (showcase && ['ready', 'must'].includes(tab))) && section !== tab) continue
      const rows = visibleRows.filter(i => section === 'all' || (cmsDataset && i.lifecycle === 'closed' ? 'closed' : i.section) === section)
      if (!rows.length) continue
      total += rows.length
      const group = box(left, label)
      group.classList.add('cw-group', 'cw-' + section)
      for (const i of rows) {
        const row = node('div', 'cw-row' + (selected === i.id ? ' cw-active' : ''))
        row.dataset.item = i.id
        const c = node('input', 'cw-check')
        c.type = 'checkbox'
        c.checked = checked.has(i.id)
        c.setAttribute('aria-label', 'Select ' + i.id + ' for handoff')
        c.dataset.focus = key('check-' + i.id)
        c.addEventListener('change', () => {
          if (c.checked) checked.add(i.id)
          else checked.delete(i.id)
          render()
        })
        const btn = button('', () => openItem(i.id), 'cw-open', 'item-' + i.id)
        btn.setAttribute('aria-label', 'Open ' + i.id + ' ' + i.title)
        btn.append(
          node('small', 'cw-id', i.id),
          node('strong', '', i.title),
          node('span', 'cw-reason', i.reason),
          node('small', 'cw-meta', i.lob ? [i.lob, i.sourceStatus, adjusters.find(a => a.id === i.ownerId)?.displayName || i.ownerId].filter(Boolean).join(' · ') : i.source + ' · ' + stamp(i.asOf)),
        )
        if (i.dueAt) btn.append(node('small', 'cw-due', 'Due ' + stamp(i.dueAt)))
        row.append(c, btn)
        group.append(row)
      }
    }
    if (!total) left.append(node('p', 'cw-empty', 'No work in this view.'))
  }
  function summaryView(main) {
    const section = box(main, 'Portfolio summary')
    const controls = node('div', 'cw-portfolio-filters')
    controls.append(field('Group claims by', select({ lob: 'Line of business', status: 'Source status', adjuster: 'Adjuster' }, groupBy, next =>
      action(async () => { groupBy = next; await loadSummary() }))),
      field('Claim status', select(allStatuses, summaryStatus, next => action(async () => { summaryStatus = next; await loadSummary() }))),
      field('Line of business', select(businessLines, summaryLob, next => action(async () => { summaryLob = next; await loadSummary() }))))
    if (isAdmin()) controls.append(field('Assigned adjuster', select({ '': 'All adjusters', ...Object.fromEntries(adjusters.map(a => [a.id, a.displayName])) },
      summaryOwner, next => action(async () => { summaryOwner = next; await loadSummary() }))))
    section.append(controls)
    if (!summaryData) return
    const open = async id => { tab = 'portfolio'; await openItem(id) }
    const fallback = () => {
      const figures = summaryMetrics(summaryData.totalBillings, summaryData.litigatedCount)
      section.append(node('p', '', [summaryData.total + ' claims', ...figures.map(pair => pair.join(' '))].join(' · ')))
      if (!summaryData.groups.length) section.append(node('p', 'cw-empty', 'No claims match this view.'))
      for (const group of summaryData.groups) {
        section.append(node('h3', '', groupName(group, summaryData.groupBy) + ' · ' + group.count))
        const metrics = summaryMetrics(group.billingsAmount, group.litigatedCount)
        if (metrics.length) section.append(node('p', '', metrics.map(pair => pair.join(' ')).join(' · ')))
        for (const row of group.items) section.append(button([row.id, claimTitle(row)].filter(Boolean).join(' · '), () => open(row.id)))
      }
    }
    closeSummary = mountSummary(section, summaryHtml, summaryData, id => action(() => open(id)), fallback)
  }
  function mailbox(left) {
    if (!inbox.length) left.append(node('p', 'cw-empty', 'No messages in your mailbox.'))
    for (const m of inbox) {
      const card = node('article', 'cw-message')
      card.append(
        node('small', 'cw-meta', m.source + ' · ' + stamp(m.at) + ' · ' + m.status),
        node('strong', '', m.summary),
        button(
          'Open ' + m.itemId,
          async () => {
            await openItem(m.itemId)
            if (showcase) {
              if (detail.item.type === 'intake') shownDetail = 'intake'
              else if (m.evidenceId) await setDocument(m.evidenceId)
              else if (detail.proposals.some((p) => p.status === 'pending')) shownDetail = 'reviews'
            }
            if (m.status === 'unread') {
              await request('mailbox/' + enc(m.id) + '/read', {})
              inbox = (await request('mailbox')).items
            }
          },
          'cw-flat',
          'mail-' + m.id,
        ),
      )
      if (m.kind === 'question' && m.status !== 'answered') {
        card.append(
          field('Answer', input('reply-' + m.id, 'Your response')),
          button('Reply', async () => {
            await request('mailbox/' + enc(m.id) + '/answer', { message: remember('reply-' + m.id) })
            keep('reply-' + m.id, '')
            await reload('Answer delivered.')
          }),
        )
      }
      left.append(card)
    }
  }
  function readSource(id) {
    return request('evidence/' + enc(id) + '?decisionSetId=' + enc(portfolio.decisionSetId))
  }
  function renderAssistant(main) {
    if (assistant?.batch) {
      const section = box(main, 'Prepared handoffs')
      for (const r of assistant.batch)
        section.append(node('strong', '', r.id + ' · ' + r.mode), node('p', 'cw-output', r.text))
      return
    }
    const a = box(main, 'Claim assistant'),
      task = select(tasks, remember('task', 'explain_priority'), (v) => keep('task', v))
    const modes = select({ replay: 'Replay fixture', live: 'Local model' }, mode, (v) => {
      mode = v
    })
    const row = node('div', 'cw-controls')
    row.append(field('Task', task), field('Run mode', modes))
    a.append(row)
    a.append(field('Question (optional)', input('question', 'Ask about the selected record')))
    a.append(
      button(
        'Run assistant',
        async () => {
          assistant = await request('assist', {
            itemId: selected,
            expectedVersion: detail.item.version,
            task: task.value,
            mode: modes.value,
            question: remember('question'),
          })
          if (showcase && task.value === 'timeline') {
            try {
              timeline = await getTimeline(request, detail.item)
            } catch {
              notice = 'The interactive view is unavailable. The text timeline is shown below.'
            }
          }
        },
        'cw-primary',
      ),
    )
    a.append(
      button('Previous sessions', async () => {
        sessions = (await request('items/' + enc(selected) + '/sessions')).items
      }),
    )
    if (showcase) {
      a.append(
        button('Open interactive timeline', async () => {
          timeline = await getTimeline(request, detail.item)
          scrollToTimeline = true
        }),
      )
      if (timeline) {
        const fallback = node('details', 'cw-transcript'),
          summary = node('summary', '', 'Text timeline')
        fallback.append(summary, node('p', 'cw-output', timeline.result.content[0].text || 'There are no recorded timeline events.'))
        const { events, sources } = timeline.result.structuredContent
        for (const row of [...sources, ...events.filter(event => event.document)].filter(row => row.anchorId))
          fallback.append(button(row.title, () => setDocument(row.document ?? row.id, row.anchorId)))
        a.append(fallback)
        closeFrame = mountTimeline(a, timeline, (source) =>
          action(async () => {
            detail = await request('items/' + enc(selected))
            await setDocument(source.id, source.anchorId)
          }), () => { fallback.open = true; scrollToTimeline = false }, frame => {
            if (scrollToTimeline) frame.scrollIntoView({ block: 'center', behavior: 'instant' })
            scrollToTimeline = false
          },
        )
      }
    }
    if (sessions) {
      if (!sessions.length) a.append(node('p', 'cw-meta', 'No previous sessions for this record.'))
      for (const r of sessions)
        a.append(
          button(
            (tasks[r.task] ?? r.task) + ' · ' + r.mode + ' · ' + stamp(r.createdAt),
            async () => {
              assistant = await request('sessions/' + enc(r.sessionId))
            },
            'cw-flat',
            'session-' + r.sessionId,
          ),
        )
    }
    if (assistant?.text) {
      a.append(
        node('small', 'cw-meta', assistant.mode + ' · ' + selected),
        node('p', 'cw-output', assistant.text),
      )
      for (const source of assistant.sources ?? [])
        a.append(
          button(
            source.title,
            async () => {
              if (showcase) await setDocument(source.id)
              else {
                evidence = await readSource(source.id)
                shownDetail = 'sources'
              }
            },
            'cw-flat',
          ),
        )
    }
  }
  function showOverview(main) {
    const i = detail.item,
      section = box(main, 'Next action')
    section.append(
      node('strong', 'cw-next', i.nextAction),
      node('p', '', i.reason),
      node('small', 'cw-meta', i.source + ' · ' + stamp(i.asOf)),
    )
    if (detail.showcase?.sourceDataset === 'cms-mcp') {
      const facts = detail.showcase
      const source = facts.documents.find(doc => doc.id === i.id + '-extract')
      const dossier = box(main, 'Claim facts')
      const fields = node('dl', 'cw-claim-facts')
      for (const [label, value, anchor] of [
        ['Policy', facts.policyNumber, 'identity'], ['Line of business', facts.lineOfBusinessName, 'identity'],
        ['Insured', facts.insured, 'assignment'], ['Client', facts.client, 'assignment'],
        ['Source adjuster', facts.sourceAdjuster, 'assignment'], ['Office', facts.office, 'assignment'],
        ['Loss date', facts.incidentDate, 'dates'], ['Reported date', facts.reportedDate, 'dates'],
        ['Source status', facts.sourceStatus, 'identity'], ['Description of loss', facts.lossDescription, 'loss'],
        ['Billings', facts.billingsAmount, 'financials'], ['Deductible', facts.deductibleAmount, 'financials'],
        ['Litigated', facts.litigated ? 'Yes' : 'No', 'financials'],
      ]) {
        if (value === undefined || value === null) continue
        fields.append(node('dt', '', label))
        const entry = node('dd')
        if (source?.anchors.some(a => a.id === anchor)) {
          const link = button(String(value), () => setDocument(source.id, anchor), 'cw-source')
          link.setAttribute('aria-label', label + ' · ' + value + ' · Open source')
          entry.append(link)
        } else entry.textContent = String(value)
        fields.append(entry)
      }
      dossier.append(fields)
      if (source) dossier.append(button('Open source extract', () => setDocument(source.id)))
    }
    if (i.ownerId === 'claims-intake')
      section.append(
        button('Claim this intake', async () => {
          await request('items/' + enc(i.id) + '/claim', { expectedVersion: i.version })
          await reload('Intake assigned to you.')
        }),
      )
    if (showcase && i.type === 'intake')
      section.append(
        button(
          'Open Intake Review',
          () => {
            shownDetail = 'intake'
          },
          'cw-primary',
        ),
      )
    if (detail.canAct) {
      if (!showcase)
        section.append(
          button('Prepare review', async () => {
            await request('items/' + enc(i.id) + '/prepare', {
              expectedVersion: i.version,
              action: 'record-review',
              decisionSetId: portfolio.decisionSetId,
            })
            await reload('Proposal prepared for review.')
            shownDetail = 'reviews'
          }),
        )
      if (
        (showcase ? detail.showcase?.capabilities?.wageRequest : i.id==='WC-102') &&
        workflowAvailable &&
        !detail.wages?.some((w) =>
          ['awaiting-partner', 'awaiting-review', 'approved', 'unknown'].includes(w.state),
        )
      )
        section.append(
          button('Request wage evidence', async () => {
            const requestId = 'wage-' + crypto.randomUUID()
            await request('wages', { itemId: i.id, expectedVersion: i.version, requestId })
            await reload(showcase ? 'Wage disclosure prepared for approval.' : 'Wage request submitted.')
            shownDetail = 'reviews'
          }),
        )
      if (i.id === 'WC-102' && !workflowAvailable)
        section.append(
          node('p', 'cw-meta', 'Start the local Story profile to run or resume a partner wage request.'),
        )
    }
    if (wageReviewEnabled && onAsk && (detail.showcase?.capabilities?.wageRequest || detail.showcase?.documents?.some(doc => ['Wage statement', 'Wage evidence request'].includes(doc.kind)))) {
      section.append(button('Review missing wage evidence', () => onAsk({ kind: 'claim', claimIds: [i.id] }, 'Review missing wage evidence for this claim.')))
    }
    renderAssistant(main)
  }
  function showSources(main) {
    const s = box(main, 'Evidence')
    if (showcase) {
      for (const doc of detail.showcase.documents)
        s.append(button(doc.title, () => setDocument(doc.id), 'cw-source'))
      const doc = detail.showcase.documents.find((d) => d.id === docId)
      if (doc) {
        showDocument(s, doc, anchorId, ui)
        if (onAsk && detail.item.type === 'claim')
          s.append(button('Ask about this document', () => onAsk({ kind: 'document', claimIds: [selected], documentId: doc.id })))
      }
      if (returnView)
        s.append(
          button(
            returnView === 'reviews' ? 'Back to review' : 'Back to overview',
            () => {
              shownDetail = returnView
              returnView = null
            },
            'cw-flat',
          ),
        )
    }
    if (!showcase)
      for (const e of detail.evidence)
        s.append(
          button(
            e.title + ' · ' + e.source,
            async () => {
              evidence = await readSource(e.id)
            },
            'cw-source',
            'source-' + e.id,
          ),
        )
    if (evidence)
      s.append(node('small', 'cw-meta', stamp(evidence.asOf)), node('p', 'cw-output', evidence.body))
    const t = box(main, 'Timeline')
    for (const e of [...detail.timeline].reverse()) {
      const entry = node('div', 'cw-entry')
      const when = ['claim.loss-date', 'claim.report-date'].includes(e.kind) ? e.at.slice(0, 10) : stamp(e.at)
      entry.append(node('small', 'cw-meta', when + ' · ' + e.source))
      if (showcase && e.evidenceId && e.anchorId)
        entry.append(button(e.summary, () => setDocument(e.evidenceId, e.anchorId), 'cw-source'))
      else entry.append(node('p', '', e.summary))
      t.append(entry)
    }
  }
  function showReviews(main) {
    const i = detail.item
    for (const w of detail.wages ?? []) {
      const a = box(main, 'Partner wage request')
      a.append(node('p', 'cw-value', w.state), node('small', 'cw-meta', w.requestId))
      if (showcase && w.state === 'awaiting-partner' && !w.taskId)
        a.append(node('small', 'cw-meta', 'Checking the existing partner registration. Refresh to check progress.'))
      if (w.state === 'awaiting-partner' && (!showcase || w.taskId) && detail.canAct && workflowAvailable)
        a.append(
          button(showcase ? 'Release partner evidence' : 'Deliver simulated partner callback', async () => {
            if (showcase) {
              await request('items/' + enc(i.id) + '/release', { requestId: w.requestId })
              await reload('Partner released the statement. Waiting for validation.')
              shownDetail = 'reviews'
              return
            }
            await request('fixtures', {
              fixtureId: 'a2a-update',
              eventId: 'callback-' + w.requestId,
              requestId: w.requestId,
            })
            await reload('Callback delivered. Refresh to see validation.')
          }),
        )
    }
    const reviewedActions=showcase && (i.claimNumber || i.id==='WC-102')
    if (reviewedActions) mountActionReview(box(main,'Claim actions'),{claimId:i.id,csrf,request:(path,body)=>request(path,body?.decision==='approve' && lostAck ? {...body,simulateLostAck:true}:body),workbench:true,onChange:()=>action(async()=>{lostAck=false;await reload('Decision recorded.')})})
    const p = reviewedActions ? main : box(main, 'Review proposals')
    if (!reviewedActions && !detail.proposals.length) p.append(node('p', 'cw-meta', 'No proposals for this record.'))
    for (const proposal of detail.proposals) {
      if (reviewedActions) continue
      const article = node('article', 'cw-entry')
      article.append(
        node('strong', '', proposal.action),
        node('p', 'cw-meta', 'Version ' + proposal.version + ' · ' + proposal.status),
        node(
          'p',
          '',
          proposal.payload?.field === 'reviewNote'
            ? 'Review note · ' +
                (proposal.payload.previousValue || 'Empty') +
                ' → ' +
                proposal.payload.proposedValue
            : proposal.payload?.commandType
              ? 'File in ' +
                proposal.payload.claimId +
                ' · JURIS revision ' +
                proposal.payload.expectedRevision
              : 'Record review',
        ),
        node('code', 'cw-digest', 'Digest ' + proposal.digest),
      )
      if (showcase && proposal.payload?.documentId) {
        const pl = proposal.payload
        article.append(
          node('blockquote', 'cw-quote', pl.quote),
          button('Inspect cited source', () => setDocument(pl.documentId, pl.anchorId), 'cw-flat'),
        )
        if (pl.commandType === 'record_wage_evidence') {
          const d = detail.showcase.documents.find((doc) => doc.id === pl.documentId)
          article.append(node('p', 'cw-meta', d?.anchors.find((a) => a.id === 'coverage')?.text || ''))
        }
      }
      if (proposal.status === 'pending' && detail.canAct) {
        for (const [decision, label] of [
          ['approve', 'Approve exact proposal'],
          ['reject', 'Reject'],
        ])
          article.append(
            button(
              label,
              async () => {
                await request('proposals/' + enc(proposal.id) + '/review', {
                  decision,
                  simulateLostAck: decision === 'approve' && lostAck,
                  expectedVersion: proposal.version,
                })
                lostAck = false
                await reload('Review decision recorded.')
                shownDetail = 'reviews'
              },
              decision === 'approve' ? 'cw-primary' : '',
            ),
          )
      }
      p.append(article)
    }
    const ops = box(main, 'Execution receipts')
    if (!detail.operations.length) ops.append(node('p', 'cw-meta', 'No execution receipts yet.'))
    for (const o of detail.operations) {
      const a = node('article', 'cw-entry')
      a.append(node('strong', '', o.state), node('small', 'cw-meta', o.receiptId || o.operationId))
      if (o.state === 'unknown' && detail.canAct)
        a.append(
          button('Reconcile receipt', async () => {
            await request('operations/' + enc(o.operationId) + '/reconcile', {})
            await reload('Receipt lookup requested.')
          }),
        )
      ops.append(a)
    }
  }
  function showPeople(main) {
    const i = detail.item
    const panel = box(main, 'People and follow-up')
    const choices = cmsDataset ? Object.fromEntries(adjusters.filter(a => a.id !== i.ownerId).map(a => [a.id, a.displayName]))
      : { maya: 'Maya', alex: 'Alex', supervisor: 'Supervisor' }
    const recipient = select(
      choices,
      remember('recipient', cmsDataset ? Object.keys(choices)[0] : identity.principalId === 'alex' ? 'maya' : 'alex'),
      (v) => keep('recipient', v),
    )
    panel.append(
      field(
        'Message type',
        select({ request: 'Work request', question: 'Question' }, remember('mailkind', 'request'), (v) =>
          keep('mailkind', v),
        ),
      ),
      field('Recipient', recipient),
      field('Request', input('message', 'What should your colleague review?')),
    )
    panel.append(
      button('Send work request', async () => {
        const message = remember('message').trim()
        if (!message) throw Error('Enter a request for your colleague.')
        await request('items/' + enc(i.id) + '/request', {
          recipientId: recipient.value,
          kind: remember('mailkind', 'request'),
          message,
          expectedVersion: i.version,
        })
        keep('message', '')
        await reload('Request delivered.')
      }),
    )
    if (detail.canAct)
      panel.append(
        button('Transfer assignment', async () => {
          await request('items/' + enc(i.id) + '/transfer', {
            recipientId: recipient.value,
            expectedVersion: i.version,
          })
          selected = null
          resetDetail()
          await reload('Assignment transferred.')
        }),
      )
    const fb = box(main, 'Priority feedback')
    const choice = select(
      { deferred: 'Defer this item', overridden: 'Override priority', reviewed: 'Reviewed' },
      remember('feedback', 'reviewed'),
      (v) => keep('feedback', v),
    )
    fb.append(
      field('Outcome', choice),
      field('Reason (optional)', input('reason', 'Why did this priority change?')),
      button('Record feedback', async () => {
        await request('decisions/' + enc(portfolio.decisionSetId) + '/feedback', {
          itemId: i.id,
          kind: choice.value,
          reason: remember('reason'),
        })
        keep('reason', '')
        notice = 'Feedback recorded.'
      }),
    )
  }
  function itemDetail(main) {
    if (!detail) {
      if (assistant?.batch) {
        renderAssistant(main)
        return
      }
      if (showcase) {
        const due = portfolio.items
          .filter((i) => i.dueAt && i.section !== 'waiting')
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        const next = due[0]
        if (next) {
          const brief = node('section', 'cw-shift-brief')
          brief.append(
            node('small', 'cw-id', 'Next deadline · ' + next.id),
            node('h2', '', next.title),
            node('p', '', next.reason),
            node('small', 'cw-meta', stamp(next.dueAt)),
            button('Review ' + next.id, () => openItem(next.id), 'cw-primary'),
          )
          main.append(brief)
          if (due.length > 1) {
            const agenda = box(main, 'Later this shift')
            for (const i of due.slice(1, 4))
              agenda.append(button(stamp(i.dueAt) + ' · ' + i.title, () => openItem(i.id), 'cw-source'))
          }
          return
        }
      }
      const blank = node('div', 'cw-placeholder')
      blank.append(
        node('h2', '', 'Record detail'),
        node('p', '', 'Open a work item to review its evidence, timeline and next action.'),
      )
      main.append(blank)
      return
    }
    const i = detail.item
    main.append(
      node('small', 'cw-id', i.type + ' · ' + i.id),
      node('h2', '', i.title),
      node('p', 'cw-meta', 'Assigned to ' + (adjusters.find(a => a.id === i.ownerId)?.displayName || i.ownerId) + ' · Record version ' + i.version),
    )
    const tabs = node('nav', 'cw-tabs')
    tabs.setAttribute('aria-label', 'Record views')
    for (const [v, title] of Object.entries({
      overview: 'Overview',
      sources: 'Evidence & timeline',
      reviews: 'Reviews',
      people: 'People',
      ...(showcase && i.type === 'intake' ? { intake: 'Intake Review' } : {}),
      ...(showcase && i.type === 'claim' && detail.showcase?.capabilities?.juris !== false ? { juris: 'JURIS record' } : {}),
    })) {
      const b = button(
        title,
        async () => {
          if (v === 'juris') juris = await request('items/' + enc(selected) + '/juris')
          shownDetail = v
        },
        'cw-tab' + (shownDetail === v ? ' cw-on' : ''),
      )
      b.setAttribute('aria-current', shownDetail === v ? 'page' : 'false')
      tabs.append(b)
    }
    main.append(tabs)
    if (shownDetail === 'overview') showOverview(main)
    else if (shownDetail === 'sources') showSources(main)
    else if (shownDetail === 'reviews') showReviews(main)
    else if (showcase && shownDetail === 'intake')
      showIntake(main, detail, ui, {
        get: remember,
        keep,
        open: openItem,
        prepare: async (data) => {
          await request('items/' + enc(selected) + '/prepare', data)
          await reload('Filing prepared for review.')
          shownDetail = 'reviews'
        },
      })
    else if (showcase && shownDetail === 'juris' && juris) showJuris(main, juris, ui)
    else showPeople(main)
  }
  function publishChatContext() {
    const item = detail?.item || portfolio?.items.find(item => item.id === selected)
    onChatContext?.({
      enabled: !!identity && !!portfolio,
      subject: identity?.subject,
      claimId: item?.type === 'claim' ? item.id : null,
    })
  }
  function render() {
    if (unmountDepartment) return
    publishChatContext()
    closeFrame?.()
    closeFrame = null
    closeSummary?.()
    closeSummary = null
    updateLink()
    const focused = screen.contains(document.activeElement) ? document.activeElement?.dataset.focus : null
    const oldScroll = screen.scrollTop
    screen.replaceChildren()
    observer?.disconnect()
    const header = node('header', 'cw-header')
    const title = node('div')
    title.append(
      node('h1', '', showcase ? 'My Shift' : 'Workbench'),
      node(
        'small',
        'cw-meta',
        showcase
          ? identity.displayName +
              ' · Synthetic shift · ' +
              new Date(portfolio.asOf).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                timeZone: 'UTC',
              })
          : identity?.displayName || 'Claims',
      ),
    )
    const controls = node('div', 'cw-identity-actions')
    if (showcase && (identity?.principalId === 'maya' || identity?.roles?.includes('supervisor') || isAdmin()))
      controls.append(
        button('Deliver missed call', async () => {
          const result = await request('showcase/call', {})
          await reload(
            result.duplicate ? 'Call is already in the mailbox.' : 'Missed call delivered to Maya’s mailbox.',
          )
          tab = 'inbox'
        }),
      )
    controls.append(button('Refresh', () => reload('Updated.'), '', 'refresh'))
    if (identity)
      controls.append(
        button(
          'Sign out',
          async () => {
            onSignOut?.(true)
            try { await request('/auth/logout', {}) }
            catch (error) { onSignOut?.(false); throw error }
            clearPrincipal()
            notice = 'You are signed out.'
            location.replace(authPath('/auth/signed-out'))
          },
          'cw-flat',
          'logout',
        ),
      )
    header.append(title, controls)
    screen.append(header)
    const feedback = node('div', 'cw-status', error || notice)
    feedback.setAttribute('role', error ? 'alert' : 'status')
    feedback.dataset.progress = ''
    screen.append(feedback)
    if (!portfolio) {
      if (!identity && needsLogin) {
        const link = node('a', 'cw-btn', 'Sign in')
        link.href = authPath('/auth/login')
        screen.append(link)
      } else if (!error) screen.append(node('p', 'cw-empty', 'Loading your work…'))
      if (error) screen.append(button('Retry', load))
      return
    }
    const tabs = node('nav', 'cw-tabs cw-mainnav')
    tabs.setAttribute('aria-label', 'Workbench views')
    for (const [v, label] of Object.entries({
      portfolio: cmsDataset && isAdmin() ? 'All adjusters' : 'My portfolio',
      ...(cmsDataset ? { summary: 'Portfolio summary' } : {}),
      inbox: 'Inbox',
      ...(showcase ? {} : { waiting: 'Waiting' }),
    })) {
      const b = button(
        label,
        async () => {
          tab = v
          portfolioPage = 0
          if (v === 'summary') await loadSummary()
        },
        'cw-tab' + (v === tab ? ' cw-on' : ''),
        'tab-' + v,
      )
      b.setAttribute('aria-current', v === tab ? 'page' : 'false')
      tabs.append(b)
    }
    if (showcase && tab !== 'summary') {
      const counts = node('div', 'cw-shift-counts')
      for (const [k, label] of Object.entries({
        must: 'Needs my action',
        waiting: 'Waiting on someone',
        ready: 'Ready for review',
      })) {
        const count = cmsDataset ? portfolio.items.filter(item => item.section === k && item.lifecycle !== 'closed').length : portfolio.counts[k]
        const card = button(
          '',
          () => {
            tab = tab === k ? 'portfolio' : k
            portfolioPage = 0
          },
          'cw-shift-count cw-' + k,
          'shift-' + k,
        )
        card.setAttribute('aria-pressed', String(tab === k))
        card.setAttribute('aria-label', label + ' (' + count + ')')
        card.append(node('strong', '', count), node('span', '', label))
        counts.append(card)
      }
      screen.append(counts)
    }
    screen.append(tabs)
    if (tab === 'summary') {
      summaryView(screen)
      return
    }
    const split = node('div', 'cw-split'),
      left = node('div', 'cw-list'),
      main = node('article', 'cw-detail')
    if (tab === 'inbox') mailbox(left)
    else portfolioList(left)
    itemDetail(main)
    split.append(left, main)
    screen.append(split)
    const demo = node('section', 'cw-demo')
    demo.append(
      button(
        simulated ? 'Close demo controls' : 'Demo controls',
        () => {
          simulated = !simulated
        },
        'cw-flat',
        'demo-toggle',
      ),
    )
    if (simulated) {
      const toggle = node('input', 'cw-check')
      toggle.type = 'checkbox'
      toggle.checked = lostAck
      toggle.addEventListener('change', () => {
        lostAck = toggle.checked
      })
      demo.append(field('Lose next approval acknowledgement', toggle))
      const fixture = select(
        {
          'voice-intake': 'Voice intake',
          'voice-team-intake': 'Unassigned team intake',
          'a2a-update': 'Independent partner update',
          'calendar-change': 'Calendar change',
          'jira-update': 'Jira issue',
          'ado-update': 'Azure Boards item',
        },
        remember('fixture', 'voice-intake'),
        (v) => keep('fixture', v),
      )
      if (!showcase)
        demo.append(
          field(
            'Queue comparison',
            select({ rules: 'Rules and deadlines', 'due-date': 'Due date only' }, ranking, (v) =>
              action(async () => {
                ranking = v
                await reload('Queue updated.')
              }),
            ),
          ),
          field('Synthetic event', fixture),
          button('Deliver fixture', async () => {
            await request('fixtures', { fixtureId: fixture.value, eventId: crypto.randomUUID() })
            await reload('Fixture delivered.')
          }),
        )
      if (identity.roles?.includes('supervisor') || isAdmin())
        demo.append(
          button('Evaluate ranking', async () => {
            evaluation = await request('evaluate', { k: 3 })
          }),
        )
    }
    if (simulated && evaluation) {
      const e = box(demo, 'Synthetic ranking evaluation')
      const pct = (n) => (n == null ? 'unavailable' : Math.round(100 * n) + '%')
      e.append(
        node(
          'small',
          'cw-meta',
          'Review budget ' +
            evaluation.k +
            ' · Label coverage ' +
            pct(evaluation.labelCoverage) +
            ' · ' +
            evaluation.disputedRows +
            ' disputed · ' +
            evaluation.missingLabelRows +
            ' missing',
        ),
      )
      for (const r of evaluation.rankers)
        e.append(
          node(
            'p',
            '',
            [
              r.ranking === 'rules' ? 'Rules and deadlines' : 'Due date only',
              'Recall ' + pct(r.recallAtK),
              'Precision on labeled items ' + pct(r.precisionAtK),
              r.mandatoryMisses + ' mandatory misses',
              'First correct action ' +
                (r.meanTimeToFirstCorrectMs == null
                  ? 'unobserved'
                  : (r.meanTimeToFirstCorrectMs / 1000).toFixed(1) + ' s'),
              'Measured sets ' + r.timedSets + '/' + r.eligibleTimingSets,
            ].join(' · '),
          ),
        )
    }
    screen.append(demo)
    screen.scrollTop = oldScroll
    if (focused)
      [...screen.querySelectorAll('[data-focus]')]
        .find((b) => b.dataset.focus === focused)
        ?.focus({ preventScroll: true })
    watchExposures()
  }
  render()
  action(load)
  onReady?.(id => action(async () => {
    resetDetail()
    tab = 'portfolio'
    await openItem(id)
  }))
  return () => {
    unmountDepartment?.()
    closeFrame?.()
    closeSummary?.()
    stop.abort()
    observer?.disconnect()
    screen.remove()
  }
}
