import { createOutlookChat } from './outlook-chat.mjs'

/** Department turns use the native composer with evidence and history served by the portfolio API. */
export function departmentChat(React, { department, csrfToken }) {
  const h = React.createElement
  const base = '/claims/api/departments/' + encodeURIComponent(department)
  const mail = createOutlookChat(React, csrfToken, () => {}, { claimNotes: false })
  const sessions = new Map()
  function session(id) {
    if (!sessions.has(id)) sessions.set(id, { listeners: new Set(), sequence: 0, view: {} })
    return sessions.get(id)
  }
  function update(s, changes) {
    s.view = { ...s.view, ...changes }
    for (const notify of s.listeners) notify()
  }
  function observe(id, notify) {
    const s = session(id)
    s.listeners.add(notify)
    return () => s.listeners.delete(notify)
  }
  function useView(id) {
    return React.useSyncExternalStore(
      (fn) => observe(id, fn),
      () => session(id).view,
    )
  }
  async function call(path, body, signal) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      signal,
      cache: 'no-store',
      headers: body && { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: body && JSON.stringify(body),
    })
    if (!response.ok)
      throw Error(
        response.status === 404 || response.status === 403
          ? 'This record or conversation is unavailable.'
          : response.status === 409
            ? 'The record changed. Review the current version.'
            : 'The department service could not complete this request.',
      )
    return response.json()
  }
  const path = (id) => '/chat/' + encodeURIComponent(id)
  async function refresh(id, signal) {
    const s = session(id),
      sequence = ++s.sequence
    try {
      const data = await call(path(id), undefined, signal)
      if (s.sequence === sequence && !signal?.aborted) update(s, { data })
    } catch (err) {
      if (s.sequence === sequence && !signal?.aborted) update(s, { data: null, review: null, error: err.message })
    }
  }
  async function scope(id, recordId) {
    const s = session(id)
    await call(path(id) + '/scope', { recordId, previous: s.view.data?.recordId ?? null })
    update(s, { review: null, error: '' })
    await refresh(id)
  }
  async function run(id, fn) {
    const s = session(id)
    if (s.view.busy) return 'hold'
    update(s, { busy: true, error: '' })
    try {
      await fn()
      return 'handled'
    } catch (err) {
      await refresh(id)
      update(s, { error: err.message })
      return 'hold'
    } finally {
      update(s, { busy: false })
    }
  }
  function Controls({ sessionId: id }) {
    const { data, busy, error } = useView(id)
    React.useEffect(() => {
      const stop = new AbortController()
      const load = () => void refresh(id, stop.signal)
      load()
      window.addEventListener('focus', load)
      return () => {
        stop.abort()
        window.removeEventListener('focus', load)
      }
    }, [id])
    return h(
      React.Fragment,
      null,
      h(
        'label',
        null,
        (data?.profile ?? department) + ' ',
        h(
          'select',
          {
            'aria-label': 'Department record',
            value: data?.recordId ?? '',
            disabled: !data || busy,
            onChange: (event) => void run(id, () => scope(id, event.target.value || null)),
          },
          h('option', { value: '' }, 'My portfolio'),
          data?.records.map((row) => h('option', { key: row.id, value: row.id }, row.id + ' · ' + row.title)),
        ),
      ),
      busy && h('span', { role: 'status' }, 'Working…'),
      error && h('span', { role: 'alert' }, error),
      h(mail.Control, { id }),
    )
  }
  function renderTurn(turn) {
    return h(
      'article',
      { className: 'cc-turn', key: turn.id },
      h('p', { className: 'cc-user-turn' }, turn.question),
      h('p', { className: 'cc-answer' }, turn.answer.text),
      turn.answer.sources.map((ref) =>
        h(
          'a',
          {
            key: [ref.recordId, ref.sourceId, ref.anchorId].join('/'),
            target: '_blank',
            rel: 'noopener',
            href:
              base +
              '/records/' +
              encodeURIComponent(ref.recordId) +
              '/sources/' +
              encodeURIComponent(ref.sourceId) +
              '?format=pdf&version=' +
              ref.version +
              '#nameddest=' +
              encodeURIComponent(ref.anchorId),
          },
          ref.title + ' ',
        ),
      ),
    )
  }
  function Transcript({ sessionId: id }) {
    const s = session(id),
      { data, busy, review } = useView(id)
    return h(
      'section',
      { className: 'cc-root cs-transcript', 'aria-label': 'Department conversation' },
      data?.turns.map(renderTurn),
      data?.workbenchTurns?.length > 0 &&
        h('details', null, h('summary', null, 'Saved Workbench answers'), data.workbenchTurns.map(renderTurn)),
      data?.actions.map((action) =>
        h(
          'button',
          {
            key: action.id,
            type: 'button',
            disabled: busy,
            onClick: () =>
              update(s, {
                review: { action, recordId: data.recordId, version: data.version, requestId: crypto.randomUUID() },
              }),
          },
          action.label,
        ),
      ),
      review &&
        review.recordId === data?.recordId &&
        review.version === data?.version &&
        h(
          'section',
          { 'aria-label': 'Review action' },
          h('p', null, review.action.preview),
          h('p', null, review.action.recipient),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () =>
                void run(id, async () => {
                  await call(
                    '/records/' +
                      encodeURIComponent(review.recordId) +
                      '/actions/' +
                      encodeURIComponent(review.action.id),
                    { requestId: review.requestId, expectedVersion: review.version },
                  )
                  update(s, { review: null })
                  await refresh(id)
                }),
            },
            'Confirm ' + review.action.label,
          ),
          h('button', { type: 'button', onClick: () => update(s, { review: null }) }, 'Cancel'),
        ),
      h(mail.Transcript, { id }),
    )
  }
  return {
    controls: Controls,
    transcript: Transcript,
    chips: () => null,
    existing: () => undefined,
    observe(id, fn) {
      const off = observe(id, fn),
        offMail = mail.observe(id, fn)
      return () => {
        off()
        offMail()
      }
    },
    hasTurns: (id) => !!session(id).view.data?.turns.length || mail.occupied(id),
    hasThread: (id) => !!session(id).view.data?.recordId || !!session(id).view.data?.turns.length,
    isScoped: () => true,
    async bind(id, target) {
      if (Object.hasOwn(target, 'record')) await scope(id, target.record)
    },
    async dispatch(id, text, attachments, signal) {
      const mailResult = await mail.dispatch(id, text, attachments, signal)
      if (mailResult) return mailResult
      return run(id, async () => {
        if (attachments) throw Error('Select a department record to use its source documents.')
        const s = session(id)
        if (!s.view.data) await refresh(id, signal)
        if (!s.view.data) throw Error('The conversation is unavailable.')
        const mentioned = [...new Set(text.toUpperCase().match(/\b(?:FIN|MAT|WC|CLM)-\d+\b/g) ?? [])]
        if (mentioned.length > 1) throw Error('Choose a single department record for this question.')
        if (mentioned.length && mentioned[0] !== s.view.data.recordId) await scope(id, mentioned[0])
        const recordId = s.view.data.recordId
        if (s.attempt?.text !== text || s.attempt.recordId !== recordId)
          s.attempt = { text, recordId, requestId: crypto.randomUUID() }
        await call(path(id) + '/ask', { question: text, recordId, requestId: s.attempt.requestId }, signal)
        s.attempt = null
        await refresh(id, signal)
      })
    },
  }
}
