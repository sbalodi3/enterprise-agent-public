import { createMailNoteControl } from './action-review.mjs'
// Route read requests before either mailbox is opened. A bare inbox is resolved by the protected planner.
export function inboxSource(text) {
  const prompt = text.replace(/["“][^"”]*["”]|`[^`]*`/g, ' ').trim()
  if (!/\b(?:inbox|outlook|emails?|e-mails?|mailbox|mail|notifi\w*)\b/i.test(prompt)) return null
  if (/\b(?:draft|compose|send|reply|forward|delete|mark|write|workspace|repository|example|hypothetical)\b|\b(?:do not|never|don't)\b/i.test(prompt)) return null
  if (!/\b(?:show|search|list|open|read|check|look|retrieve|find|what|which|any|unread|give|view|inbox)\b/i.test(prompt)) return null
  const outlook = /\b(?:outlook|e-?mails?)\b/i.test(prompt)
  const workbench = /\bworkbench\b/i.test(prompt)
  if (outlook && workbench) return null
  if (outlook) return 'outlook'
  if (workbench || /\bnotifi\w*/i.test(prompt)) return 'workbench'
  if (/\binbox\b/i.test(prompt) && !/\b(?:for|from|about|subject|sender|containing|regarding)\s+(?!(?:my|the) inbox)\S/i.test(prompt)) return 'ambiguous'
  return null
}

// Shared by the protected composer and the server. A draft or quoted example never initiates mail retrieval.
export function outlookIntent(text, { selected = false, previous = false } = {}) {
  const prompt = text.trim().replace(/["“][^"”]*["”]|`[^`]*`/g, ' ').replace(/‘[^’]*’|'[^'\n]+'/g, ' ')
  const read = /\b(search|find|look (?:up|for|through)|check|show|list|retrieve|read|open|summari[sz]e|pull up|give me)\b/i
  const mail = /\b(outlook|inbox|mailboxes|mailbox|e-?mails?|mail)\b/i
  const drafting = /^(?:(?:please|can you|could you|would you|help me|I want to|I need to)\s+)*(?:draft|write|compose|send|reply|forward|delete|move|edit|mark)\b|\b(?:and|then|to)\s+(?:draft|write|compose|send|reply|forward|delete|move|edit)\b|\b(?:draft|write|compose)\b.{0,30}\b(?:mail|email|message|reply)\b/i
  const otherSource = /\b(?:workspace|source code|repo(?:sitory)?|on disk|local file|\.eml|example (?:prompt|query)|hypothetical)\b/i
  const mixed = /\b(?:compare|combine|cross.?check|match)\b.{0,100}\b(?:claim (?:file|record|documents?)|workbench|workspace)\b/i
  if (drafting.test(prompt) || /\b(?:do not|don.t|never|without)\s+(?:open|search|read|check|use|access)\b/i.test(prompt)) return selected ? 'blocked' : 'other'
  if (mixed.test(prompt) && (selected || mail.test(prompt))) return 'mixed'
  if (otherSource.test(prompt) || /\b(?:example of|an example|hypothetically|how (?:do|would|could) (?:I|we)|the phrase|button label|retention policy|outlook (?:settings|feature|installation|configuration))\b/i.test(prompt)) return selected ? 'blocked' : 'other'
  const source = inboxSource(text)
  if (source === 'workbench' || (!selected && source === 'ambiguous')) return 'other'
  if (previous && ordinalOf(prompt, 1) !== null) return 'mail'
  if (selected) return 'mail'
  const mailQuestion = /\b(?:what|when|who|which|did|were|any)\b/i.test(prompt) &&
    /\b(?:my (?:outlook|mailbox|inbox|e-?mails?)|e-?mail(?:ed)? me|send me|in (?:my|the) inbox|e-?mail (?:from|about|say)|(?:recent|latest|last|unread) e-?mails?)\b/i.test(prompt)
  return (read.test(prompt) || mailQuestion) && mail.test(prompt) ? 'mail' : 'other'
}

export function ordinalOf(text, length) {
  const ordinals = ['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth']
  const prompt = text.trim().replace(/^(?:(?:please|can you|could you|would you)\s+)*/i,'')
    .replace(/[,\s]+please[.!?]?$/i,'')
  if (/^(?:open|read|show|summari[sz]e) (?:me )?(?:it|that (?:one|email|message))[.!?]?$/i.test(prompt)) return length === 1 ? 0 : -1
  const match = /^(?:open|read|show|summari[sz]e)\s+(?:me\s+)?(?:the\s+)?(?:(?:message|email|result)\s+#?)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|\d+(?:st|nd|rd|th)?)\b(?:\s+(?:one|message|email|result))?\s*[.!?]?$/i.exec(prompt)
  if (!match) return null
  const term = match[1].toLowerCase()
  return term === 'last' ? length - 1 : ordinals.includes(term) ? ordinals.indexOf(term) : parseInt(term, 10) - 1
}

const feedback = {
  outlook_not_connected: 'Connect Outlook Mail in App connections to search your mailbox.',
  outlook_reconnect: 'Reconnect Outlook Mail in App connections to continue.',
  mail_turn_busy: 'An Outlook search is already running in this chat. Try again when it finishes.',
  mail_reference_missing: 'Choose a message from the results or search Outlook again.',
  mail_turn_interrupted: 'The Outlook connection or sign-in changed. Search again after reconnecting.',
  mail_read_only: 'Outlook Mail supports searching and reading messages.',
  mail_invalid_zone: 'Set a valid time zone for this search.',
  microsoft_connection_changed: 'Your Outlook connection changed. Check App connections and retry.',
  microsoft_reconnect_required: 'Reconnect Outlook Mail in App connections to continue.',
  graph_resource_unavailable: 'The requested Outlook resource is unavailable. Try searching again.',
  graph_throttled: 'Outlook is receiving too many requests. Try again shortly.',
  graph_access_denied: 'Microsoft did not grant access to this message.',
  graph_service_unavailable: 'Microsoft could not complete this mailbox request. Try again shortly.',
  local_model_unavailable: 'The mail agent could not reach its model. Try again.',
}
export function createOutlookChat(React, csrf, onHandled, { claimNotes = true } = {}) {
  const h = React.createElement
  // Claims may bind multiple native session IDs to one protected claim thread. Outlook history belongs to each native ID.
  const entries = new Map()
  function state(id) {
    if (!entries.has(id)) entries.set(id, { value: {}, listeners: new Set() })
    return entries.get(id)
  }
  function set(s, update) {
    s.value = { ...s.value, ...update }
    for (const cb of s.listeners) cb()
  }
  function observe(id, fn) {
    const listeners = state(id).listeners
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
  function useSnapshot(id) {
    const subscribe = React.useCallback(fn => observe(id,fn), [id])
    return React.useSyncExternalStore(subscribe, () => state(id).value)
  }
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const markUsed = (id, occupied) => {
    try {
      if (occupied) sessionStorage.setItem('enterprise.mail-chat.used.' + id, '1')
      else sessionStorage.removeItem('enterprise.mail-chat.used.' + id)
    } catch { /* The application can still render a private in-memory session. */ }
  }
  function occupied(id) {
    const v = state(id).value
    if (v.mailPending || v.mailTurns?.length) return true
    try { return !!sessionStorage.getItem('enterprise.mail-chat.used.' + id) } catch { return false }
  }
  async function call(id, body, signal, before) {
    const response = await fetch('/claims/api/mail-chat/' + encodeURIComponent(id) +
      (before ? '?before=' + encodeURIComponent(before) : ''), {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
      ...(body && { headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }),
    })
    const payload = await response.json()
    if (!response.ok) throw Object.assign(new Error(feedback[payload.code] ||
      (response.status === 401 ? 'Sign in again to access Outlook.' : 'Outlook could not complete this request. Try again.')),
    { status: response.status, code: payload.code })
    return payload
  }
  function lastSource(id, inMail) {
    const key = 'enterprise.mail-chat.last.' + id
    try {
      if (inMail !== undefined) sessionStorage.setItem(key, inMail ? 'mail' : 'other')
      const value = sessionStorage.getItem(key)
      return value === null ? undefined : value === 'mail'
    } catch { return undefined }
  }
  async function refresh(id, signal) {
    const s = state(id), ticket = s.mailTicket = (s.mailTicket || 0) + 1
    const result = await call(id, null, signal)
    if (ticket === s.mailTicket && !signal?.aborted) {
      markUsed(id, result.turns.length > 0 || s.value.mailPending)
      const first = s.value.mailTurns?.findIndex(t => t.id === result.turns[0]?.id) ?? -1
      const retained = result.more && first > 0 ? s.value.mailTurns.slice(0, first) : []
      set(s, { mailTurns: [...retained, ...result.turns], mailMore: retained.length > 0 ? s.value.mailMore : result.more,
        mailConnected: result.connected, mailLoaded: true,
        ...(!result.connected ? { mailSelected: false } : {}) })
    }
  }
  async function earlier(id) {
    const s = state(id)
    if (s.value.mailLoadingEarlier || !s.value.mailTurns?.length) return
    const before = s.value.mailTurns[0].id
    set(s, { mailLoadingEarlier: true })
    try {
      const page = await call(id, null, undefined, before)
      if (before === s.value.mailTurns?.[0]?.id) set(s, {mailTurns: [...page.turns, ...s.value.mailTurns], mailMore: page.more})
    } catch (e) { set(s, {mailError: e.message}) }
    finally { set(s, {mailLoadingEarlier: false}) }
  }
  function promptSource(id, s) {
    return h('button', { type: 'button', className: 'cs-trigger', 'aria-pressed': !!s.value.mailSelected,
      onClick() { lastSource(id, false); set(s, { mailSelected: !s.value.mailSelected, mailError: '', mailFollowup: false }) } }, 'Outlook Mail')
  }
  function Control({ id }) {
    const s = state(id)
    useSnapshot(id)
    React.useEffect(() => {
      const abort = new AbortController()
      const update = () => void refresh(id, abort.signal).catch(e => {
        if (!abort.signal.aborted && (e.status === 401 || e.status === 403)) set(s, { mailTurns: [], mailConnected: false, mailSelected: false })
      })
      update()
      window.addEventListener('focus', update)
      window.addEventListener('app-connections-changed', update)
      return () => { abort.abort(); window.removeEventListener('focus', update); window.removeEventListener('app-connections-changed', update) }
    }, [id])
    return h(React.Fragment, null, (s.value.mailConnected || s.value.mailSelected) && promptSource(id, s),
      s.value.mailPending && h('span', { role: 'status' }, 'Searching Outlook…'),
      s.value.mailError && h('span', { className: 'cs-notice', role: 'alert' }, s.value.mailError))
  }
  async function dispatch(id, text, attachments, signal, readRef, allowFollowup = true) {
    const s = state(id)
    if (allowFollowup && !s.value.mailLoaded && s.value.mailFollowup === undefined && lastSource(id) !== false && ordinalOf(text, 1) !== null)
      await refresh(id, signal)
    const previous = allowFollowup && (s.value.mailFollowup ?? lastSource(id) ?? !!s.value.mailTurns?.length)
    const route = outlookIntent(text, { selected: s.value.mailSelected, previous })
    if (route === 'other') { lastSource(id, false); set(s, { mailFollowup: false, mailError: '' }); return null }
    if (route === 'blocked' || route === 'mixed' || attachments) {
      set(s, { mailError: attachments || route === 'mixed' ? 'Search Outlook or choose a claim or workspace source for this question.' : 'Clear Outlook Mail to continue with this request.' })
      return 'hold'
    }
    if (s.value.mailPending) return 'hold'
    const attempt = s.mailAttempt?.question === text && s.mailAttempt?.readRef === readRef ? s.mailAttempt :
      { question: text, requestId: crypto.randomUUID(), ...(readRef && {readRef}) }
    s.mailAttempt = attempt
    set(s, { mailPending: true, mailError: '' })
    s.mailTicket = (s.mailTicket || 0) + 1
    try {
      const result = await call(id, { ...attempt, selected: !!s.value.mailSelected, timeZone: zone() }, signal)
      s.mailAttempt = null
      ++s.mailTicket
      markUsed(id, true)
      lastSource(id, true)
      onHandled?.(id)
      set(s, { mailFollowup: true, mailTurns: [...(s.value.mailTurns || []).filter(t => t.id !== attempt.requestId), result.turn] })
      return 'handled'
    } catch (error) {
      if (!signal?.aborted) {
        set(s, { mailError: error.message })
        if (['outlook_not_connected','outlook_reconnect','microsoft_connection_changed','microsoft_reconnect_required'].includes(error.code))
          await refresh(id, signal).catch(() => {})
      }
      return 'hold'
    } finally { set(s, { mailPending: false }) }
  }
  const MailNote=createMailNoteControl(React)
  function transcript(id, turns) {
    if (!turns?.length) return null
    return h('section', { className: 'cc-root cs-transcript', 'aria-label': 'Outlook conversation history' },
      state(id).value.mailMore && h('button', { type: 'button', className: 'cs-trigger', disabled: state(id).value.mailLoadingEarlier,
        onClick: () => void earlier(id) }, 'Show earlier Outlook messages'),
      turns.map(t => h('article', { className: 'cc-turn', key: t.id },
        h('div', { className: 'cc-user-turn' }, h('p', null, t.question)),
        h('div', { className: 'cc-answer' }, h('p', null, t.answer.text),
          t.answer.range && h('p', null, [t.answer.range.from, t.answer.range.to].filter(Boolean).join(' – ') + ' (' + t.answer.range.timeZone + ')'),
          t.answer.items?.length > 0 && h('ol', null, t.answer.items.map(item => h('li', { key: item.ref },
            t.answer.kind === 'search' && state(id).value.mailConnected ? h('button', { type: 'button', className: 'cs-mail-result',
              disabled: state(id).value.mailPending, onClick: () => void dispatch(id, 'Read this Outlook message.', 0, undefined, item.ref) },
              item.subject) : item.subject,
            h('div', null, item.from + ' · ', h('time', { dateTime: item.receivedAt }, date.format(new Date(item.receivedAt)))),
            t.answer.kind === 'search' && h('p', null, item.excerpt),
            item.webLink && h('a', { href: item.webLink, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Outlook')))),
          claimNotes && t.answer.kind==='read' && h(MailNote,{session:id,turnId:t.id,answer:t.answer,csrf}),
          t.answer.partial && h('p', null, 'Partial results. Narrow the search to see more matches.')))))
  }
  function Transcript({ id }) { return transcript(id, useSnapshot(id).mailTurns) }
  return { Control, Transcript, dispatch, occupied, observe, useSnapshot, state: id => state(id).value,
    clearSelection(id) { lastSource(id,false); set(state(id), { mailSelected: false, mailFollowup: false, mailError: '' }) } }
}
