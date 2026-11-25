import { request } from './claim-chat.mjs'

export function selections(scope) {
  const entries = new Map()
  for (const id of scope?.claimIds || []) {
    const docs = scope.kind === 'document' ? [scope.documentId] : scope.documents?.[id]
    entries.set(id, docs ? new Set(docs) : null)
  }
  return entries
}

export function currentScopeLabel(scope) {
  return 'Current · ' + [...selections(scope)].map(([claim, docs]) =>
    docs ? claim + ' (' + [...docs].join(', ') + ')' : claim).join(', ')
}
export function selectionScope(entries) {
  const claimIds = [...entries.keys()].sort()
  if (!claimIds.length) return { kind: 'workspace' }
  const documents = Object.fromEntries([...entries].filter(([, docs]) => docs !== null)
    .map(([id, docs]) => [id, [...docs].sort()]))
  return { kind: claimIds.length === 1 ? 'claim' : 'multi', claimIds,
    ...(Object.keys(documents).length ? { documents } : {}) }
}

export function createScopePicker(React) {
  const h = React.createElement
  const { useEffect, useLayoutEffect, useState, useRef } = React

  function ClaimRow({ item, selected, update, remember }) {
    const id = item.id
    const [expanded, setExpanded] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const [docs, setDocs] = useState(null)
    const [error, setError] = useState('')
    const checkbox = useRef(null)
    const all = selected === null
    useLayoutEffect(() => { checkbox.current.indeterminate = selected instanceof Set }, [selected])
    useEffect(() => {
      if (!expanded) return
      const stop = new AbortController()
      setDocs(null); setError('')
      request('documents/' + encodeURIComponent(id), { signal: stop.signal }).then(({ items }) => {
        if (!stop.signal.aborted) { setDocs(items); remember(id, items) }
      }).catch(e => { if (!stop.signal.aborted) setError(e.message) })
      return () => stop.abort()
    }, [id, expanded, attempt])
    function toggleDoc(documentId) {
      const ids = docs.map(d => d.id)
      const next = new Set(all ? ids : selected || [])
      if (next.has(documentId)) next.delete(documentId)
      else next.add(documentId)
      // Checking individual files pins those IDs, even if they are every file available today.
      update(id, next.size ? next : undefined)
    }
    return h('li', { className: 'cs-record' },
      h('div', { className: 'cs-row' },
        h('label', null, h('input', { ref: checkbox, type: 'checkbox', checked: all, 'aria-label': 'Select ' + id,
          onChange: () => update(id, all ? undefined : null) }),
          h('span', null, h('strong', null, id), h('span', { className: 'cs-title' }, item.title))),
        h('small', null, [item.lob, item.sourceStatus || item.lifecycle].filter(Boolean).join(' · ')),
        h('button', { type: 'button', 'aria-expanded': expanded, 'aria-label': 'Documents for ' + id,
          onClick: () => setExpanded(!expanded) }, expanded ? 'Hide documents' : 'Documents')),
      expanded && h('div', { className: 'cs-docs' },
        error ? h('p', { role: 'alert' }, error, ' ', h('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, 'Retry')) :
        docs === null ? h('p', { role: 'status' }, 'Loading documents…') :
        docs.length ? docs.map(doc => h('label', { key: doc.id },
          h('input', { type: 'checkbox', checked: all || !!selected?.has(doc.id), onChange: () => toggleDoc(doc.id) }),
          h('span', null, doc.title), h('small', null, doc.kind))) : h('p', null, 'No documents available.')))
  }

  return function ScopePicker({ scope, apply, close }) {
    const dialog = useRef(null), knownDocs = useRef(new Map())
    const [draft, setDraft] = useState(() => selections(scope))
    const [query, setQuery] = useState(''), [status, setStatus] = useState('all')
    const [offset, setOffset] = useState(0), [attempt, setAttempt] = useState(0)
    const [result, setResult] = useState(null), [error, setError] = useState(''), [saving, setSaving] = useState(false)
    useLayoutEffect(() => {
      const previous = document.activeElement, node = dialog.current
      node.showModal()
      return () => { node.close(); if (previous?.isConnected) previous.focus() }
    }, [])
    useEffect(() => {
      const stop = new AbortController()
      setResult(null); setError('')
      const timer = setTimeout(() => {
        const params = new URLSearchParams({ q: query, status, offset: String(offset), limit: '20' })
        request('search?' + params, { signal: stop.signal }).then(items => {
          if (!stop.signal.aborted) setResult(items)
        }).catch(e => { if (!stop.signal.aborted) setError(e.message) })
      }, query ? 140 : 0)
      return () => { clearTimeout(timer); stop.abort() }
    }, [query, status, offset, attempt])
    function update(id, docs) {
      setDraft(old => {
        const next = new Map(old)
        if (docs === undefined) next.delete(id)
        else next.set(id, docs)
        return next
      })
    }
    async function submit() {
      setSaving(true); setError('')
      try { await apply(selectionScope(draft), knownDocs.current); close() }
      catch (e) { setError(e.message); setSaving(false) }
    }
    return h('dialog', { ref: dialog, className: 'cs-dialog', 'aria-label': 'Choose scope',
      onCancel(e) { e.preventDefault(); if (!saving) close() } },
      h('header', null, h('h2', null, 'Choose scope'), h('button', { type: 'button', disabled: saving, onClick: close, 'aria-label': 'Close scope picker' }, '×')),
      h('p', null, 'Select claims or individual documents for this conversation.'),
      h('div', { className: 'cs-filters' }, h('input', { type: 'search', autoFocus: true, 'aria-label': 'Find a claim',
        placeholder: 'Search your claims', value: query, onChange(e) { setQuery(e.target.value); setOffset(0) } }),
        h('select', { 'aria-label': 'Claim status', value: status, onChange(e) { setStatus(e.target.value); setOffset(0) } },
          ['all','open','closed'].map(v => h('option', { key: v, value: v }, v === 'all' ? 'All statuses' : v === 'open' ? 'Open claims' : 'Closed claims')))),
      h('div', { className: 'cs-results' }, result ? h('ul', null, result.items.map(item =>
        h(ClaimRow, { key: item.id, item, selected: draft.get(item.id), update, remember: (id, docs) => knownDocs.current.set(id, docs) }))) :
        !error && h('p', { role: 'status' }, 'Loading claims…'),
        result?.items.length === 0 && h('p', null, 'No matching claims.'),
        error && h('p', { role: 'alert' }, error, ' ', h('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, 'Retry'))),
      result?.total > 20 && h('nav', { 'aria-label': 'Claim results' },
        h('button', { type: 'button', disabled: !offset, onClick: () => setOffset(offset - 20) }, 'Previous'),
        h('span', null, (offset + 1) + '–' + Math.min(offset + 20, result.total) + ' of ' + result.total),
        h('button', { type: 'button', disabled: offset + 20 >= result.total, onClick: () => setOffset(offset + 20) }, 'Next')),
      h('footer', null, h('span', { role: 'status' }, draft.size + (draft.size === 1 ? ' claim selected' : ' claims selected')),
        h('button', { type: 'button', disabled: saving, onClick: close }, 'Cancel'),
        h('button', { type: 'button', className: 'cs-apply', disabled: saving || draft.size > 12, onClick: submit }, saving ? 'Applying…' : 'Apply scope')))
  }
}
