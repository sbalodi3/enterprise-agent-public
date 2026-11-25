export function createWorkbenchPanel(React) {
  const h = React.createElement
  return function Panel({ onOpenChat, embedded = false, onFailure, onSignOut, resume, retryQuery = '' }) {
    const root = React.useRef(null)
    const openRecord = React.useRef(null)
    const followingCard = React.useRef(false)
    const launcher = React.useRef(null)
    const dialog = React.useRef(null)
    const [failed, setFailed] = React.useState(false)
    const [surface, setSurface] = React.useState(null)
    const [context, setContext] = React.useState(null)
    const [open, setOpen] = React.useState(false)
    const [visited, setVisited] = React.useState(false)
    const [target, setTarget] = React.useState(null)
    const ask = React.useCallback((scope, question) => {
      setTarget({ scope, question })
      setOpen(true)
      setVisited(true)
    }, [])
    const collapse = React.useCallback(() => {
      setOpen(false)
      requestAnimationFrame(() => launcher.current?.focus())
    }, [])
    React.useEffect(() => {
      if (!embedded) {
        const url = new URL(location.href)
        url.searchParams.set('mode', 'workbench')
        url.hash = 'workbench'
        if (location.href !== url.href) history.replaceState(history.state, '', url)
      }
      let disposed = false, unmount, last
      import('/claims/assets/workbench.mjs' + retryQuery)
        .then(({ mountWorkbench }) => {
          if (disposed) return
          unmount = mountWorkbench(root.current, {
            onAsk: ask, onOpenDepartmentChat: onOpenChat, onReady: open => { openRecord.current = open }, embedded, resume, onSignOut,
            onChatContext(next) {
              if (last?.enabled === next.enabled && last?.subject === next.subject && last?.claimId === next.claimId) return
              if (!next.enabled || last?.subject !== next.subject) {
                setOpen(false)
                setVisited(false)
              }
              const keepThread = followingCard.current && next.enabled && last?.subject === next.subject
              last = next
              setContext(next)
              if (keepThread) return
              setTarget({ scope: next.claimId ? { kind: 'claim', claimIds: [next.claimId] } : { kind: 'portfolio' } })
            },
          })
        })
        .catch(() => { if (!disposed) setFailed(true) })
      return () => { disposed = true; unmount?.() }
    }, [ask, embedded, resume, onSignOut, retryQuery])
    React.useEffect(() => {
      if (!context?.enabled) return
      let active = true
      import('/claims/assets/claim-chat.mjs' + retryQuery).then(({ createClaimChat }) => {
        if (active) setSurface(() => createClaimChat(React))
      }).catch(() => { if (active) setFailed(true) })
      return () => { active = false }
    }, [context?.enabled, retryQuery])
    React.useLayoutEffect(() => {
      const panel = dialog.current
      if (!panel || !open) return
      const small = matchMedia('(max-width: 640px)')
      function place() {
        if (panel.open) panel.close()
        if (small.matches) panel.showModal()
        else panel.show()
        panel.querySelector('textarea')?.focus()
      }
      place()
      small.addEventListener('change', place)
      return () => {
        small.removeEventListener('change', place)
        if (panel.open) panel.close()
      }
    }, [open, visited, context?.enabled, surface])
    if (failed && onFailure) return onFailure()
    return h(React.Fragment, null,
      h('link', { rel: 'stylesheet', href: '/claims/assets/workbench.css' }),
      context?.enabled && h('link', { rel: 'stylesheet', href: '/claims/assets/claim-chat.css' }),
      context?.enabled && h('link', { rel: 'stylesheet', href: '/claims/assets/native-claims.css' }),
      h('div', { className: 'cw-work-area' + (open ? ' cw-drawer-open' : '') + (embedded ? ' cw-embedded' : '') },
        h('div', { ref: root, className: 'cw-work-main' }, failed ? 'Workbench could not load. Refresh to retry.' : null),
        context?.enabled && surface && h(React.Fragment, null,
          h('button', {
            type: 'button', ref: launcher, className: 'cc-launcher', hidden: open,
            'aria-expanded': open, 'aria-controls': 'cw-chat-drawer',
            onClick: () => { setOpen(true); setVisited(true) },
          }, 'Ask agent'),
          visited && h('aside', { id: 'cw-chat-drawer', className: 'cc-drawer', hidden: !open, 'aria-label': 'Workbench agent' },
            h('dialog', { className: 'cc-drawer-dialog', ref: dialog, 'aria-label': 'Claims chat panel',
              onCancel: (e) => { e.preventDefault(); collapse() } },
              h(surface, { key: context.subject, target, visible: open, onCollapse: collapse,
                onOpenCase: async id => {
                  followingCard.current = true
                  collapse()
                  try { await openRecord.current?.(id) } finally { followingCard.current = false }
                }, onOpenChat: onOpenChat && (conversation => onOpenChat({ conversation })) })))),
      ),
    )
  }
}
