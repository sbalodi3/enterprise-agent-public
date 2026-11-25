// Shared claims conversation view for the hosted shell and the Workbench drawer.
import { mountActionReview, createMailNoteControl } from './action-review.mjs'
import { createScopePicker, currentScopeLabel } from './claim-scope.mjs'
import { pdfViewerHref, openPdfDialog } from './pdf-link.mjs'
import { mountCases, mountSummary, mountTimeline } from './timeline-host.mjs'
import { businessLines, casePresentation, claimTitle, groupName, summaryMetrics } from './widget-format.mjs'

const api = '/claims/api/chat/'
const enc = encodeURIComponent
const portfolio = { kind: 'portfolio' }
const messages = {
  401: 'Your sign-in has ended. Sign in again to continue.',
  403: 'Access to this conversation has changed.',
  404: 'This conversation or source is no longer available.',
  409: 'The record changed. Refresh and read the current evidence.',
  422: 'The agent could not verify an answer from these sources.',
  503: 'The local model or claims service is unavailable. Retry when it is ready.',
}

export async function request(path, { signal, body, csrf } = {}) {
  const response = await fetch(api + path, {
    credentials: 'same-origin', cache: 'no-store', signal,
    ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const error = new Error(messages[response.status] || 'The claims request failed. Try again.')
    error.status = response.status
    throw error
  }
  return response.json()
}

export function replyToQuestion(conversation, csrf, expectedRevision, turn, response) {
  return request('turn/' + enc(conversation), { csrf, body: {
    kind: 'reply', turnId: turn.id, questionId: turn.pendingQuestion.id, expectedRevision, ...response,
  } })
}

function scopeLabel(scope) {
  if (scope?.kind === 'workspace') return 'Workspace'
  if (scope?.kind === 'document') return 'Document · ' + (scope.title || scope.documentId)
  if (scope?.kind === 'claim') return 'Claim · ' + scope.claimIds[0]
  if (scope?.kind === 'multi') return scope.claimIds.length + ' claims · ' + scope.claimIds.join(' + ')
  return 'My portfolio'
}

function sourcePath(conversation, source) {
  const fields = new URLSearchParams()
  for (const key of ['claimId', 'claimVersion', 'documentId', 'documentVersion', 'anchorId']) fields.set(key, source[key])
  return 'source/' + enc(conversation) + '?' + fields
}

function validRef(ref) {
  return ref?.claimId && ref.documentId && ref.anchorId && Number.isInteger(ref.claimVersion) && Number.isInteger(ref.documentVersion)
}

/** Create components using the React instance supplied by the native plugin loader. */
export function createClaimChat(React) {
  const h = React.createElement
  const ScopePicker = createScopePicker(React)
  const { useState, useEffect, useRef, useId } = React
  const btn = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label)
  const chip = (scope) => h('span', { className: 'cc-chip', 'data-kind': scope.kind }, scopeLabel(scope))

  function Activity({ rows, live }) {
    if (!rows?.length) return null
    return h('details', { className: 'cc-activity', ...(live && { open: true }) },
      h('summary', null, 'Activity', h('span', { className: 'cc-count' }, rows.length)),
      h('ol', null, rows.map((row) => h('li', { key: row.id, 'data-state': row.state },
        h('span', null, row.label), h('small', null, row.state)))))
  }

  function Timeline({ value, sources, onSource }) {
    const root = useRef(null)
    const open = useRef(null)
    open.current = (row) => {
      const source = sources.find((s) => s.documentId === row.id && s.anchorId === row.anchorId)
      if (source) onSource(source)
    }
    // Refetches return fresh objects. Remount only when the recorded timeline actually changes.
    const payload = JSON.stringify(value)
    const [failed, setFailed] = useState(false)
    useEffect(() => {
      const controller = new AbortController()
      const el = root.current
      let dispose
      setFailed(false)
      ;(async () => {
        const response = await fetch('/claims/assets/claim-timeline.widget.json', { signal: controller.signal })
        if (!response.ok) throw Error('Missing timeline application')
        const resource = await response.json()
        if (controller.signal.aborted) return
        const timeline = JSON.parse(payload)
        const result = { structuredContent: timeline }
        dispose = mountTimeline(el, { resource, result, version: timeline.version }, (row) => open.current(row), () => setFailed(true))
      })().catch(() => { if (!controller.signal.aborted) setFailed(true) })
      return () => { controller.abort(); dispose?.(); el.replaceChildren() }
    }, [payload])
    return h('div', { className: 'cc-timeline' },
      h('div', { ref: root }),
      failed && h('p', null, 'Interactive timeline unavailable.'),
      h('details', { ...(failed && { open: true }) }, h('summary', null, 'Timeline as text'),
        !value.sources.length && !value.events.length && h('p', null, 'There are no recorded timeline events.'),
        h('ol', null, [...value.events, ...value.sources].sort((a, b) => a.at.localeCompare(b.at)).map((entry, i) =>
          h('li', { key: i }, (entry.dateOnly ? entry.at.slice(0, 10) : entry.at) + ' · ',
            (entry.id || entry.document) && entry.anchorId ? btn(entry.title, () => open.current({ id: entry.document ?? entry.id, anchorId: entry.anchorId })) : entry.title)))))
  }

  function CaseExplorer({ value, onOpenCase }) {
    const defaults = value.filters || { status: 'open', assignedOnly: true, dueToday: value.view === 'due', waitingOnly: value.view === 'waiting' }
    const [query, setQuery] = useState(defaults.query || '')
    const [status, setStatus] = useState(defaults.status || 'open')
    const [lob, setLob] = useState(defaults.lobs?.join(',') || defaults.lob || '')
    const [adjusters, setAdjusters] = useState(null)
    const [owner, setOwner] = useState(defaults.ownerId || (defaults.assignedOnly ? 'mine' : ''))
    const [result, setResult] = useState(undefined)
    const [offset, setOffset] = useState(defaults.offset || 0)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const active = useRef(null), applied = useRef(null)
    const snapshot = JSON.stringify(value)
    const previousSnapshot = useRef(snapshot)
    useEffect(() => () => active.current?.abort(), [])
    useEffect(() => {
      const ctl = new AbortController()
      fetch('/claims/api/adjusters', { cache: 'no-store', signal: ctl.signal }).then(async response => {
        if (!response.ok) throw Error('Unable to load adjuster choices.')
        const roster = await response.json()
        if (!ctl.signal.aborted && roster.canFilterByOwner) setAdjusters(roster.items)
      }).catch(() => { if (!ctl.signal.aborted) setError('Unable to load adjuster choices.') })
      return () => ctl.abort()
    }, [])
    const current = result === undefined ? value : result
    function paramsFor(filters, pageOffset) {
      const params = new URLSearchParams({ q: filters.query || '', status: filters.status || 'open', offset: String(pageOffset), limit: '12' })
      for (const line of filters.lobs || (filters.lob ? [filters.lob] : [])) params.append('lob', line)
      for (const key of ['dueToday', 'waitingOnly', 'assignedOnly', 'ownerId', 'sourceStatus']) {
        if (filters[key]) params.set(key, String(filters[key]))
      }
      return params
    }
    async function fetchPage(params, view) {
      active.current?.abort()
      const ctl = new AbortController()
      active.current = ctl
      // Hide prior authorizations while replacing a filtered or paginated view.
      setResult(null)
      setBusy(true)
      setError('')
      try {
        const page = await request('search?' + params, { signal: ctl.signal })
        if (!ctl.signal.aborted) {
          const pageOffset = Number(params.get('offset'))
          if (pageOffset > 0 && pageOffset >= page.total) {
            const last = Math.max(0, Math.ceil(page.total / 12) - 1) * 12
            params.set('offset', String(last))
            return fetchPage(params, view)
          }
          setResult({ ...page, view })
          setOffset(pageOffset)
        }
      } catch (err) {
        if (!ctl.signal.aborted) setError(err.message)
      } finally {
        if (!ctl.signal.aborted) setBusy(false)
      }
    }
    function search() {
      const params = paramsFor({ ...defaults, query, status, lobs: lob ? lob.split(',') : [], assignedOnly: owner === 'mine', ownerId: owner === 'mine' ? '' : owner }, 0)
      applied.current = params
      return fetchPage(params, 'search')
    }
    function load(pageOffset) {
      const params = new URLSearchParams(applied.current || paramsFor(defaults, 0))
      params.set('offset', String(pageOffset))
      applied.current = params
      return fetchPage(params, 'search')
    }
    useEffect(() => {
      const refresh = () => {
        const params = applied.current || paramsFor(defaults, defaults.offset || 0)
        void fetchPage(params, applied.current ? 'search' : value.view)
      }
      if (snapshot !== previousSnapshot.current) {
        previousSnapshot.current = snapshot
        if (applied.current) refresh()
        else { active.current?.abort(); setResult(undefined); setBusy(false); setError('') }
      }
      window.addEventListener('claims:portfolio-refreshed', refresh)
      const visible = () => { if (!document.hidden && applied.current) refresh() }
      document.addEventListener('visibilitychange', visible)
      return () => {
        window.removeEventListener('claims:portfolio-refreshed', refresh)
        document.removeEventListener('visibilitychange', visible)
      }
    }, [snapshot])
    return h('div', { className: 'cc-case-explorer' },
      h('form', { onSubmit: e => { e.preventDefault(); search() } },
        h('input', { type: 'search', 'aria-label': 'Search case list', placeholder: 'Claim number or keywords', value: query, onChange: e => setQuery(e.target.value) }),
        h('select', { 'aria-label': 'Case list lifecycle', value: status, onChange: e => setStatus(e.target.value) },
          ...[['all','All statuses'],['open','Open'],['closed','Closed']].map(([v,l]) => h('option',{ key:v,value:v },l))),
        h('select', { 'aria-label': 'Case list business line', value: lob, onChange: e => setLob(e.target.value) },
          h('option', { value: '' }, 'All business lines'),
          h('option', { value: 'AUTO,COMM_AUTO' }, 'Auto · Personal and commercial'),
          defaults.lobs?.length > 1 && defaults.lobs.join(',') !== 'AUTO,COMM_AUTO' &&
            h('option', { value: defaults.lobs.join(',') }, defaults.lobs.join(' + ')),
          ...Object.entries(businessLines).filter(([v]) => v).map(([v,label]) => h('option',{ key:v,value:v }, label))),
        defaults.sourceStatus && h('span', null, defaults.sourceStatus),
        !adjusters && owner === 'mine' && h('span', null, 'Assigned to me'),
        adjusters && h('select', { 'aria-label': 'Case list assigned adjuster', value: owner, onChange: e => setOwner(e.target.value) },
          h('option', { value: '' }, 'All adjusters'),
          h('option', { value: 'mine' }, 'Assigned to me'),
          ...adjusters.map(a => h('option', { key: a.id, value: a.id }, a.displayName))),
        h('button', { type:'submit', disabled:busy }, 'Search cases')),
      error && h('p', {role:'alert'}, error),
      current ? h(PortfolioApp, { value:current, onOpenCase }) : busy && h('p', {role:'status'}, 'Refreshing cases…'),
      current && (offset > 0 || current.total > current.items.length) && h('nav', { 'aria-label':'Case list pages' },
        btn('Previous cases', () => load(Math.max(0, offset - 12)), {disabled:busy || !offset}),
        h('span', null, (offset + 1) + '–' + (offset + current.items.length) + ' of ' + current.total),
        btn('Next cases', () => load(offset + 12), {disabled:busy || offset + current.items.length >= current.total})))
  }
  function PortfolioApp({ value, onOpenCase, summary = false }) {
    const root = useRef(null), open = useRef(null)
    const [failed, setFailed] = useState(false)
    open.current = onOpenCase
    const payload = JSON.stringify(value)
    useEffect(() => {
      const ctl = new AbortController()
      const el = root.current
      let dispose
      setFailed(false)
      fetch('/claims/assets/' + (summary ? 'portfolio-summary.widget.json' : 'open-cases.widget.json'), { signal: ctl.signal }).then(async response => {
        if (!response.ok) throw Error('Portfolio application unavailable')
        const resource = await response.json()
        if (!ctl.signal.aborted) dispose = (summary ? mountSummary : mountCases)(el, resource, JSON.parse(payload), id => open.current(id), () => setFailed(true))
      }).catch(() => { if (!ctl.signal.aborted) setFailed(true) })
      return () => { ctl.abort(); dispose?.(); el.replaceChildren() }
    }, [payload, summary])
    if (summary) return h('div', null, h('div', { ref: root }), h('details', { ...(failed && { open: true }) },
      h('summary', null, 'Portfolio summary as text'),
      h('p', null, [value.total + ' claims', ...summaryMetrics(value.totalBillings, value.litigatedCount).map(pair => pair.join(' '))].join(' · ')),
      !value.groups.length && h('p', null, 'No claims match this view.'),
      value.groups.map(group => h('details', { key: group.key },
        h('summary', null, groupName(group, value.groupBy) + ' · ' + group.count),
        h('p', null, summaryMetrics(group.billingsAmount, group.litigatedCount).map(pair => pair.join(' ')).join(' · ')),
        group.items.map(item => btn([item.id, claimTitle(item)].filter(Boolean).join(' · '), () => onOpenCase(item.id), { key: item.id }))))))
    return h('div', null, h('div', { ref: root }), h('details', { ...(failed && { open: true }) },
      h('summary', null, 'Case list as text'), h('p', null, value.total ? 'Showing ' + value.items.length + ' of ' + value.total + ' cases' : 'No cases match this view.'),
      value.items.map(item => {
        const { headline, context } = casePresentation(item, value.view === 'search')
        return h('p', { key: item.id }, btn(context + ' · ' + headline, () => onOpenCase(item.id)), item.dueAt && ' · Due ' + item.dueAt)
      })))
  }

  function ClaimSearch({ select, exclude = [] }) {
    const [query, setQuery] = useState('')
    const [items, setItems] = useState([])
    const [error, setError] = useState('')
    useEffect(() => {
      const ctl = new AbortController()
      setItems([])
      setError('')
      const timer = setTimeout(() => {
        request('search?status=all&q=' + enc(query), { signal: ctl.signal })
          .then((data) => { if (!ctl.signal.aborted) setItems(data.items) })
          .catch((e) => { if (!ctl.signal.aborted) setError(e.message) })
      }, 120)
      return () => { clearTimeout(timer); ctl.abort() }
    }, [query])
    return h('div', { className: 'cc-search' },
      h('label', null, 'Find a claim', h('input', { type: 'search', value: query, onChange: (e) => setQuery(e.target.value), autoFocus: true })),
      items.filter((i) => !exclude.includes(i.id)).map((i) => btn(i.id + ' · ' + i.title, () => select(i), { key: i.id })),
      error && h('p', { role: 'alert' }, error))
  }

  function Suggestion({ items, question, choose }) {
    const [options, setOptions] = useState(items)
    const [selected, setSelected] = useState(() => items.map((i) => i.id))
    const [adding, setAdding] = useState(false)
    return h('fieldset', { className: 'cc-suggest' }, h('legend', null, 'Claims to compare'),
      options.map((item) => h('label', { key: item.id }, h('input', { type: 'checkbox',
        checked: selected.includes(item.id), onChange: (event) => setSelected((old) =>
          event.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id)) }), item.id + ' · ' + item.title)),
      btn(adding ? 'Close claim search' : 'Add claim', () => setAdding(!adding), { 'aria-expanded': adding }),
      adding && h(ClaimSearch, { exclude: options.map((i) => i.id), select(item) {
        setOptions([...options, item]); setSelected([...selected, item.id]); setAdding(false)
      } }),
      btn(selected.length === 1 ? 'Ask about selected claim' : 'Compare selected', () =>
        choose({ kind: selected.length === 1 ? 'claim' : 'multi', claimIds: [...selected].sort() }, question),
        { className: 'cc-primary', disabled: !selected.length || selected.length > 12 }))
  }

  function Clarification({ turn, reply }) {
    const question = turn.pendingQuestion
    const [other, setOther] = useState(false), [custom, setCustom] = useState('')
    const [busy, setBusy] = useState(false), [error, setError] = useState('')
    const attempt = useRef(null), sending = useRef(false)
    async function answer(value) {
      if (sending.current) return
      sending.current = true
      setBusy(true); setError('')
      const key = JSON.stringify(value)
      if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID() }
      try { await reply(turn, { ...value, requestId: attempt.current.requestId }) }
      catch (e) { setError(e.message) }
      finally { sending.current = false; setBusy(false) }
    }
    return h('fieldset', { className: 'cc-question', disabled: busy }, h('legend', null, question.question),
      h('div', { className: 'cc-choices' },
        question.options.filter(opt => opt.id !== 'other').map(opt => btn(
          h(React.Fragment, null, opt.label, opt.description && h('small', null, opt.description)),
          () => answer({ answer: { selected: [opt.id] } }), { key: opt.id })),
        question.allowOther && question.options.length > 0 && btn('Other', () => setOther(true), { 'aria-expanded': other })),
      question.allowOther && (other || !question.options.length) && h('form', { onSubmit: e => {
        e.preventDefault()
        if (custom.trim()) void answer({ answer: { selected: [], custom: custom.trim() } })
      } }, h('label', null, 'Your answer', h('input', { autoFocus: true, maxLength: 1000,
        value: custom, onChange: e => setCustom(e.target.value) })),
        h('button', { type: 'submit', disabled: !custom.trim() }, 'Continue')),
      btn('Cancel question', () => answer({ cancel: true }), { className: 'cc-cancel-question' }),
      error && h('p', {role:'alert'}, error))
  }

  function AnsweredQuestions({ rows }) {
    return h('dl', { className: 'cc-answered', 'aria-label': 'Clarification answers' }, rows.map(({ question, answer }) =>
      h('div', { key: question.id }, h('dt', null, question.question),
        h('dd', null, answer.custom || question.options.find(option => answer.selected.includes(option.id))?.label))))
  }

  function WorkAnswer({ answer }) {
    const [expanded, setExpanded] = useState(false)
    return h('div', { className: 'cc-work-answer' }, h('p', null, answer.text),
      answer.work.sections.filter(section => section.items.length).map(section => h('section', { key: section.label },
        h('h4', null, section.label), h('ul', null, (expanded ? section.items : section.items.slice(0, 12)).map(item =>
          h('li', { key: item.id }, h('strong', null, item.label), h('small', null,
            [item.itemId, item.title, item.source, item.status, item.dueAt && 'Due ' + new Date(item.dueAt).toLocaleString(),
              item.at && new Date(item.at).toLocaleString()].filter(Boolean).join(' · '))))))),
      !expanded && answer.work.sections.some(s => s.items.length > 12) && btn('Show all results', () => setExpanded(true)))
  }

  const MailNote=createMailNoteControl(React)
  function ActionReview({context,csrf}) {
    const root=useRef(null)
    useEffect(()=>mountActionReview(root.current,{claimId:context.claimId,csrf,context}),[context.claimId,context.proposalId,csrf])
    return h('section',{ref:root,'aria-label':'Claim actions'})
  }
  function OutlookAnswer({ conversationId, turnId, csrf }) {
    const [result, setResult] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0)
    useEffect(() => {
      const ctl = new AbortController()
      setResult(null); setError('')
      fetch('/claims/api/mail-chat/claims-' + enc(conversationId) + '?turn=' + enc(turnId), {
        signal: ctl.signal, credentials: 'same-origin', cache: 'no-store',
      }).then(async res => {
        if (!res.ok) throw Error(messages[res.status] || 'Could not retrieve this Outlook result.')
        const data = await res.json()
        if (!ctl.signal.aborted) setResult(data.turn.answer)
      }).catch(e => { if (!ctl.signal.aborted) setError(e.message) })
      return () => ctl.abort()
    }, [conversationId, turnId, retry])
    if (error) return h('p', {role:'alert'}, error, ' ', btn('Retry', () => setRetry(retry + 1)))
    if (!result) return h('p', {role:'status'}, 'Loading Outlook result…')
    return h('div', null, h('p', null, result.text), h('ul', null, result.items.map(item => h('li', { key: item.ref },
      item.webLink ? h('a', {href:item.webLink, target:'_blank', rel:'noopener noreferrer'}, item.subject) : item.subject,
      h('small', null, ' · ' + item.from + ' · ' + new Date(item.receivedAt).toLocaleString()),
      result.kind === 'search' && h('p', null, item.excerpt)))),
      result.kind==='read' && h(MailNote,{session:'claims-'+conversationId,turnId,answer:result,csrf}),
      result.partial && h('p', null, 'Partial results. Narrow the search to see more matches.'))
  }

  function Turn({ turn, scope, onSource, choose, retry, onOpenCase, reply, conversationId, csrf }) {
    const answer = turn.answer
    const cases = turn.cases || answer?.cases
    const card = onOpenCase && (answer?.summary ? h(PortfolioApp, { value: answer.summary, onOpenCase, summary: true })
      : cases && h(cases.explorable || cases.view === 'search' || cases.items?.some(i => i.lob) ? CaseExplorer : PortfolioApp,
        { key: cases.view, value: cases, onOpenCase }))
    if (card && !answer) return h('article', { className: 'cc-turn' }, card)
    if(turn.state==='stale' && turn.actionClaim) return h(ActionReview,{csrf,context:{claimId:turn.actionClaim,suggestions:['status']}})
    if (turn.state === 'unavailable' || turn.state === 'stale') return h('p', { className: 'cc-notice' },
      turn.state === 'stale' ? 'Earlier information has changed. Ask again for the current record.' : 'An earlier turn is no longer available.')
    const sources = answer?.sources || []
    const byClaim = new Map()
    for (const ref of sources.filter(validRef)) {
      if (!byClaim.has(ref.claimId)) byClaim.set(ref.claimId, [])
      byClaim.get(ref.claimId).push(ref)
    }
    return h('article', { className: 'cc-turn', 'data-turn-state': turn.state },
      h('div', { className: 'cc-user-turn' }, turn.plan?.kind === 'workbench' || turn.plan?.kind === 'outlook'
        ? h('span', { className:'cc-chip' }, turn.plan.kind === 'outlook' ? 'Outlook Mail' : turn.plan.operation === 'actions' ? 'Workbench actions' : 'Workbench Inbox')
        : scope?.kind === 'workspace' && ['running','awaiting_input'].includes(turn.state)
          ? h('span', { className: 'cc-chip' }, 'Choosing a source') : chip(scope), h('p', null, turn.question)),
      !!turn.clarifications?.length && h(AnsweredQuestions, { rows: turn.clarifications }),
      turn.state === 'awaiting_input' && turn.pendingQuestion && reply &&
        h(Clarification, { key: turn.pendingQuestion.id, turn, reply }),
      turn.state === 'cancelled' && h('p', { className: 'cc-notice' }, 'Question cancelled.'),
      h(Activity, { rows: turn.activity || answer?.activity, live: turn.state === 'running' }),
      turn.state === 'running' && h('p', { role: 'status', className: 'cc-notice' }, 'Working on your question…'),
      turn.state === 'failed' && h('div', { role: 'alert', className: 'cc-notice' },
        h('p', null, ({ local_model_unavailable: messages[503],
          outlook_reconnect: 'Reconnect Outlook Mail in App connections to search your inbox.',
          outlook_not_connected: 'Connect Outlook Mail in App connections to search your inbox.'
        })[turn.error] || 'The agent could not finish a verified answer.'), btn('Retry question', () => retry(turn.question, turn.requestId)),
        onOpenCase && scope.kind === 'claim' && btn('Open claim record', () => onOpenCase(scope.claimIds[0]))),
      answer && h('div', { className: 'cc-answer' }, card || (answer.work ? h(WorkAnswer, { answer }) : answer.outlookRef ? h(OutlookAnswer, { conversationId, turnId: answer.outlookRef,csrf })
          : !answer.wageReview && h('p', null, answer.text)),
        answer.actionContext && h(ActionReview,{context:answer.actionContext,csrf}),
        answer.why && h('details', null, h('summary', null, 'Why this answer'), h('p', null, answer.why)),
        ...Array.from(byClaim, ([claim, refs]) => h('div', { className: 'cc-sources', key: claim },
          byClaim.size > 1 && h('small', null, claim),
          refs.map((ref) => btn(ref.title || ref.documentId, (event) => onSource(ref, sources, event.currentTarget),
            { key: ref.documentId + '#' + ref.anchorId, className: 'cc-source-button', title: ref.anchorId })))),
        answer.wageReview && h(WageReview, { answer, onSource: ref => onSource(ref, sources) }),
        answer.timeline && h(Timeline, { value: answer.timeline, sources, onSource: (ref) => onSource(ref, sources) }),
        !!answer.suggestedClaims?.length && h(Suggestion, { items: answer.suggestedClaims, question: turn.question, choose })))
  }

  function WageReview({ answer, onSource }) {
    const root = useRef(null), source = useRef(onSource)
    source.current = onSource
    const [failed, setFailed] = useState(false)
    const payload = JSON.stringify(answer.wageReview)
    useEffect(() => {
      let active = true, dispose
      setFailed(false)
      import('/claims/assets/wage-review.bundle.mjs').then(({ renderReview }) => {
        if (active) dispose = renderReview(root.current, JSON.parse(payload), index => {
          const ref = answer.sources[index]
          if (ref && validRef(ref)) source.current(ref)
        })
      }).catch(() => { if (active) setFailed(true) })
      return () => { active = false; dispose?.() }
    }, [payload])
    return h('section', { 'aria-label': 'Wage evidence review', 'data-layout': answer.wageReview.layout }, h('div', { ref: root }),
      failed && h('p', { role: 'status' }, 'Interactive review unavailable. Use the text and cited passages.'),
      h('details', { open: failed || undefined }, h('summary', null, 'Review as text'), h('p', {className:'cc-answer'}, answer.text)))
  }

  function SourcePanel({ conversation, selected, sources, onSelect, close, askDocument }) {
    const [state, setState] = useState({})
    const header = useRef(null), cited = useRef(null)
    const path = sourcePath(conversation, selected)
    useEffect(() => {
      const controller = new AbortController()
      let generation = 0
      async function load() {
        const ticket = ++generation
        try {
          const doc = await request(path, { signal: controller.signal })
          if (ticket === generation && !controller.signal.aborted) setState({ path, doc })
        } catch (e) { if (ticket === generation && !controller.signal.aborted) setState({ path, error: e.message }) }
      }
      void load()
      const refresh = () => { if (document.visibilityState === 'visible') void load() }
      window.addEventListener('focus', refresh)
      return () => { controller.abort(); window.removeEventListener('focus', refresh) }
    }, [path])
    useEffect(() => { header.current?.focus() }, [path])
    const doc = state.path === path && state.doc
    useEffect(() => { if (doc) cited.current?.scrollIntoView({ block: 'nearest' }) }, [doc, path])
    return h('section', { className: 'cc-preview', 'aria-label': 'Source document' },
      h('header', null, btn('Back to conversation', close), h('h3', { ref: header, tabIndex: -1 }, selected.title || selected.documentId)),
      sources.length > 1 && h('nav', { 'aria-label': 'Cited passages' }, sources.filter(validRef).map((ref) => btn(ref.title || ref.documentId, () => onSelect(ref), {
        key: ref.claimId + ref.documentId + ref.anchorId, 'aria-pressed': sourcePath(conversation, ref) === path,
      }))),
      state.path === path && state.error ? h('p', { role: 'alert' }, state.error) : !doc ? h('p', { role: 'status' }, 'Opening source…') :
      h('div', { className: 'cc-paper' }, h('p', { className: 'cc-muted' }, doc.source + ' · ' + selected.claimId + ' · Version ' + doc.version),
        doc.anchors.map((anchor) => h('section', { key: anchor.id, className: anchor.id === selected.anchorId ? 'cc-cited' : '', ref: anchor.id === selected.anchorId ? cited : null },
          h('h4', null, anchor.label), h('p', null, anchor.text))),
        h('div', { className: 'cc-paper-actions' },
          h('a', { href: pdfViewerHref({ ...selected, conversation }), onClick: openPdfDialog }, 'Open PDF'),
          btn('Ask about this document', () => askDocument({ kind: 'document', claimIds: [selected.claimId], documentId: selected.documentId })))))
  }

  function Picker({ choose, resume, close }) {
    const [recent, setRecent] = useState([])
    const [error, setError] = useState('')
    useEffect(() => {
      const ctl = new AbortController()
      request('conversations', { signal: ctl.signal }).then((data) => setRecent(data.items)).catch((e) => { if (!ctl.signal.aborted) setError(e.message) })
      return () => ctl.abort()
    }, [])
    return h('section', { className: 'cc-picker', 'aria-label': 'Choose conversation scope' },
      h('header', null, h('h3', null, 'Choose a conversation'), btn('Done', close)),
      btn('My portfolio', () => choose(portfolio)),
      h(ClaimSearch, { select: (i) => choose({ kind: 'claim', claimIds: [i.id] }) }),
      !!recent.length && h('h4', null, 'Recent conversations'),
      recent.map((c) => btn(scopeLabel(c.scope), () => resume(c.id), { key: c.id })),
      error && h('p', { role: 'alert' }, error))
  }

  function Session({ initial, csrf, planned, choose, full, visible, drafts, staged, consume, onCollapse, onPicker, onOpenChat, onOpenCase }) {
    const id = initial.id
    const [conversation, setConversation] = useState(initial)
    const finalInitialTurn = initial.turns.at(-1)
    const [text, setText] = useState(() => drafts.get(id) ?? (finalInitialTurn?.state === 'failed' ? finalInitialTurn.question : ''))
    const restoredFailure = useRef(finalInitialTurn?.state === 'failed' ? finalInitialTurn.requestId : null)
    const [error, setError] = useState('')
    const [sending, setSending] = useState(false)
    const [preview, setPreview] = useState(null)
    const [denied, setDenied] = useState(false)
    const [watching, setWatching] = useState(false)
    const textarea = useRef(null), log = useRef(null)
    const reads = useRef(0), active = useRef(true), pending = useRef(null), uncertain = useRef(null), previewButton = useRef(null)
    const watchId = useId()
    const running = conversation.turns.some((t) => t.state === 'running')
    const awaitingInput = conversation.turns.some(t => t.state === 'awaiting_input')
    const [attach, setAttach] = useState(false)
    const scope = conversation.scope
    const changeDraft = (v) => { drafts.set(id, v); setText(v) }

    function apply(snapshot, ticket) {
      if (snapshot.id !== id || !active.current || (ticket !== undefined && ticket !== reads.current)) return
      ++reads.current
      setConversation(snapshot)
      setDenied(false)
      setError('')
      if (preview && !snapshot.turns.some((turn) => (turn.answer?.sources || []).some((ref) =>
        sourcePath(id, ref) === sourcePath(id, preview.selected)))) setPreview(null)
      const last = snapshot.turns.at(-1)
      if (last?.state === 'failed' && restoredFailure.current !== last.requestId) {
        restoredFailure.current = last.requestId
        if (!drafts.get(id)) changeDraft(last.question)
      } else if (last?.state === 'running') restoredFailure.current = null
      const attempt = uncertain.current
      if (attempt && snapshot.turns.some((turn) => turn.requestId === attempt.requestId || turn.id === attempt.requestId)) {
        if (drafts.get(id) === attempt.question) changeDraft('')
        uncertain.current = null
      }
      if (!snapshot.turns.some((t) => t.state === 'running')) setWatching(false)
    }
    function report(e, ticket) {
      if (!active.current || e.name === 'AbortError' || (ticket !== undefined && ticket !== reads.current)) return
      if ([401, 403, 404].includes(e.status)) {
        setDenied(e.status); setPreview(null); drafts.delete(id); setText('')
      }
      setError(e.message || 'The claims request failed.')
    }
    useEffect(() => { active.current = true; return () => { active.current = false } }, [])
    useEffect(() => {
      if (visible && !denied) textarea.current?.focus()
    }, [visible, denied])
    useEffect(() => {
      if (!visible) return
      const ctl = new AbortController()
      const refresh = () => {
        const ticket = ++reads.current
        return request('conversation/' + enc(id), { signal: ctl.signal }).then((snapshot) => {
          if (!ctl.signal.aborted) apply(snapshot, ticket)
        }).catch((e) => report(e, ticket))
      }
      void refresh()
      const onFocus = () => { if (document.visibilityState === 'visible') void refresh() }
      window.addEventListener('focus', onFocus)
      window.addEventListener('claims:portfolio-refreshed', onFocus)
      document.addEventListener('visibilitychange', onFocus)
      return () => { ctl.abort(); window.removeEventListener('claims:portfolio-refreshed', onFocus); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
    }, [id, visible, preview?.selected])
    useEffect(() => {
      if (denied || !visible || !(watching || running)) return
      const ctl = new AbortController()
      let timer, polling = false
      const stream = new EventSource(api + 'events/' + enc(id))
      function fallback() {
        if (polling || ctl.signal.aborted) return
        polling = true
        stream.close()
        clearTimeout(timer)
        void poll()
      }
      function armFallback() {
        clearTimeout(timer)
        timer = setTimeout(fallback, 3500)
      }
      armFallback()
      const handle = (event) => {
        if (ctl.signal.aborted || polling) return
        try {
          const snapshot = JSON.parse(event.data)
          apply(snapshot)
          if (snapshot.turns.some((t) => t.state === 'running')) armFallback()
          else { clearTimeout(timer); stream.close() }
        } catch { fallback() }
      }
      async function poll() {
        if (ctl.signal.aborted) return
        const ticket = ++reads.current
        try {
          const data = await request('conversation/' + enc(id), { signal: ctl.signal })
          if (ctl.signal.aborted) return
          apply(data, ticket)
          if (data.turns.some((t) => t.state === 'running')) timer = setTimeout(poll, 1000)
        } catch (e) { report(e, ticket); if (!ctl.signal.aborted && !e.status) timer = setTimeout(poll, 2000) }
      }
      stream.addEventListener('conversation', handle)
      stream.addEventListener('unavailable', fallback)
      stream.onerror = fallback
      return () => { ctl.abort(); stream.close(); clearTimeout(timer) }
    }, [id, running, watching, denied, visible])
    async function send(question = text, retryId) {
      const q = question.trim()
      if (!q || pending.current || running || awaitingInput || denied) return
      setError(''); setSending(true); restoredFailure.current = null
      const requestId = retryId || (uncertain.current?.question === q ? uncertain.current.requestId : crypto.randomUUID())
      const attempt = { question: q, requestId }
      pending.current = attempt
      uncertain.current = attempt
      try {
        await request('turn/' + enc(id), { body: { ...attempt, ...(planned && { planned: true, expectedFocus: conversation.focus || null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }), expectedRevision: conversation.scopeRevision }, csrf })
        if (!active.current) return
        if (drafts.get(id)?.trim() === q) changeDraft('')
        uncertain.current = null
        setWatching(true)
        const ticket = ++reads.current
        const snapshot = await request('conversation/' + enc(id))
        apply(snapshot, ticket)
      } catch (e) { report(e) }
      finally { pending.current = null; if (active.current) setSending(false) }
    }
    useEffect(() => {
      if (staged && visible && !denied) {
        consume()
        changeDraft(staged)
        void send(staged)
      }
    }, [staged, visible, denied])
    useEffect(() => {
      const node = log.current
      if (node && !preview) node.scrollTop = node.scrollHeight
    }, [conversation.turns.length, running])
    async function reply(turn, response) {
      try {
        await replyToQuestion(id, csrf, conversation.scopeRevision, turn, response)
        setWatching(true)
        apply(await request('conversation/' + enc(id)))
      } catch (error) {
        if (error.status === 409) apply(await request('conversation/' + enc(id)))
        throw error
      }
    }
    async function pin(next) {
      apply(await request('scope/' + enc(id), { csrf, body: { scope: next, resetFocus: true, expectedRevision: conversation.scopeRevision } }))
    }
    function closePreview() {
      setPreview(null)
      requestAnimationFrame(() => (previewButton.current?.isConnected ? previewButton.current : textarea.current)?.focus())
    }
    function open(ref, refs, control) {
      if (!validRef(ref)) return
      if (control) previewButton.current = control
      setPreview({ selected: ref, sources: refs.filter(validRef) })
    }
    function keydown(e) {
      if (e.key === 'Escape') {
        if (preview) closePreview()
        else if (onCollapse) onCollapse()
      }
    }
    return h('div', { inert: visible ? undefined : '', 'aria-hidden': visible ? undefined : true, className: 'cc-session' + (preview ? ' cc-has-preview' : ''), onKeyDown: keydown },
      attach && h(ScopePicker, {scope, apply:pin, close:() => setAttach(false)}),
      h('header', { className: 'cc-head' }, h('div', null, h('h2', null, 'Claims chat'), !denied &&
        (planned && scope.claimIds?.length ? h('span', { className:'cc-chip' }, 'Pinned · ' + scopeLabel(scope)) : chip(scope)),
        !denied && conversation.focus?.claimIds?.length > 0 && JSON.stringify(conversation.focus) !== JSON.stringify(scope) &&
          h('span', { className:'cc-chip' }, currentScopeLabel(conversation.focus))),
        h('div', { className: 'cc-controls' },
          btn('Choose scope', planned ? () => setAttach(true) : onPicker, { disabled: running || awaitingInput }),
          planned && btn('Conversations', onPicker),
          !full && onOpenChat && !denied && btn('Open in Chat', () => onOpenChat(id)),
          !full && !onOpenChat && (!denied || denied === 401) && h('a', { href: '/auth/hosted-chat?conversation=' + enc(id) },
            denied === 401 ? 'Sign in to resume this conversation' : 'Open in Chat'),
          onCollapse && btn('Collapse', onCollapse))),
      h('div', { className: 'cc-layout' },
        h('div', { className: 'cc-conversation' },
          h('div', { className: 'cc-log', ref: log, 'aria-label': 'Conversation history', tabIndex: 0 },
            !denied && !conversation.turns.length && h('p', { className: 'cc-empty' },
              scope.kind === 'portfolio' ? 'Ask about your assigned claims and upcoming deadlines.' : 'Ask about this ' + (scope.kind === 'multi' ? 'selection of claims.' : scope.kind + ' and its evidence.')),
            !denied && conversation.turns.map((t) => h(Turn, { csrf,key: t.id, turn: t, scope: t.scope || scope, conversationId: id, reply,
              onOpenCase, onSource: open, choose, retry: (q, requestId) => { changeDraft(q); void send(q, requestId) } })),
            error && h('p', { role: 'alert', className: 'cc-notice' }, error)),
          !denied && h('form', { className: 'cc-composer', onSubmit: (event) => { event.preventDefault(); void send() } },
            h('label', { htmlFor: watchId }, 'Message the claims agent'),
            h('textarea', { ref: textarea, id: watchId, value: text, rows: 2, maxLength: 2000, placeholder: 'Ask a question…', onChange: (e) => changeDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } } }),
            h('div', null, h('small', null, 'Local model'), h('button', { type: 'submit', className: 'cc-primary', disabled: sending || running || awaitingInput || !text.trim() }, 'Send')))),
        !denied && preview && h(SourcePanel, { conversation: id, ...preview,
          onSelect: (selected) => setPreview({ ...preview, selected }), close: closePreview, askDocument: choose })))
  }

  function ClaimChat({ target, full = false, visible = true, onCollapse, onOpenChat, onOpenCase }) {
    const [selected, setSelected] = useState(target)
    const [state, setState] = useState(null)
    const [picker, setPicker] = useState(false)
    const [retry, setRetry] = useState(0)
    const drafts = useRef(new Map())
    const staged = useRef(null)
    useEffect(() => { staged.current = target?.question || null; setSelected(target); setPicker(false) }, [target])
    useEffect(() => {
      const ctl = new AbortController()
      setState(null)
      ;(async () => {
        const boot = await request('bootstrap', { signal: ctl.signal })
        if (!boot.enabled) throw Error('Claims chat is available in the connected showcase.')
        const record = selected?.id
          ? await request('conversation/' + enc(selected.id), { signal: ctl.signal })
          : await request('conversations', { signal: ctl.signal, csrf: boot.csrfToken, body: { scope: selected?.scope || portfolio } })
        if (!ctl.signal.aborted) {
          setState({ selected, record, csrf: boot.csrfToken, planned: !!boot.plannedTurns })
          if (full) {
            const url = new URL(location.href)
            url.hash = 'claim-chat'; url.searchParams.set('conversation', record.id)
            history.replaceState(history.state, '', url)
          }
        }
      })().catch((e) => { if (!ctl.signal.aborted) setState({ selected, error: e.message }) })
      return () => ctl.abort()
    }, [selected, retry])
    function choose(scope, question) {
      setPicker(false)
      staged.current = typeof question === 'string' ? question : null
      setSelected({ scope })
    }
    return h('section', { className: 'cc-root ' + (full ? 'cc-full' : 'cc-compact'), 'aria-label': 'Claims chat' },
      picker && h(Picker, { choose, resume: (id) => { setSelected({ id }); setPicker(false) }, close: () => setPicker(false) }),
      state?.selected !== selected || !state ? h('p', { className: 'cc-notice', role: 'status' }, 'Opening conversation…') :
      state.error ? h('div', { className: 'cc-notice', role: 'alert' }, h('p', null, state.error),
        btn('Retry', () => setRetry(retry + 1)), btn('Choose scope', () => setPicker(true)), onCollapse && btn('Collapse', onCollapse)) :
      h(Session, { key: state.record.id, csrf: state.csrf, planned: state.planned, initial: state.record, visible: visible && !picker, full, drafts: drafts.current, staged: staged.current,
        consume: () => { staged.current = null }, choose, onCollapse, onOpenChat, onOpenCase, onPicker: () => setPicker(true) }))
  }
  return Object.assign(ClaimChat, { Turn, SourcePanel })
}
