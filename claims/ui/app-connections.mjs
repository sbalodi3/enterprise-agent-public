const endpoint = '/claims/api/connections'

/** The employee gateway owns both the connection and its displayed state. */
export function createAppConnections(React, { Button, Switch, Modal }) {
  const h = React.createElement
  return function AppConnections() {
    const heading = React.useRef(null)
    const lifetime = React.useRef(null)
    const timer = React.useRef(null)
    const sequence = React.useRef(0)
    const [account, setAccount] = React.useState(null)
    const [csrf, setCsrf] = React.useState('')
    const [confirm, setConfirm] = React.useState(false)
    const [busy, setBusy] = React.useState('')
    const [error, setError] = React.useState('')
    const [notice, setNotice] = React.useState('')

    async function refresh(signal) {
      const request = ++sequence.current
      const res = await fetch(endpoint, { cache: 'no-store', signal })
      if (!res.ok) throw Error('Could not load your app connections.')
      const data = await res.json()
      const mail = data.apps?.find(app => app.id === 'outlook-mail')
      if (!mail || !data.csrfToken) throw Error('Could not load your app connections.')
      if (!signal.aborted && request === sequence.current) {
        setCsrf(data.csrfToken)
        setAccount(mail)
        setError('')
      }
      return mail
    }
    function reload() {
      const signal = lifetime.current.signal
      void refresh(signal).catch(error => { if (!signal.aborted) setError(error.message) })
    }
    React.useEffect(() => {
      const controller = new AbortController()
      lifetime.current = controller
      heading.current?.focus({ preventScroll: true })
      reload()
      window.addEventListener('focus', reload)
      return () => {
        controller.abort()
        clearTimeout(timer.current)
        window.removeEventListener('focus', reload)
      }
    }, [])

    React.useEffect(() => {
      if (account) window.dispatchEvent(new Event('app-connections-changed'))
    }, [account?.status, account?.address, account?.version])

    async function mutate(action, signal) {
      const res = await fetch(endpoint + '/outlook-mail/' + action, {
        method: 'POST', headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
        body: '{}', cache: 'no-store', signal,
      })
      if (!res.ok) throw Error(action === 'connect' ? 'Could not start Outlook sign-in.' : 'Could not disconnect Outlook.')
      return action === 'connect' ? res.json() : undefined
    }

    function connect() {
      setConfirm(false)
      setError('')
      setNotice('')
      // Open synchronously from the confirmation click so browsers allow the new window.
      const child = window.open('about:blank', '_blank', 'popup,width=600,height=720')
      if (!child) { setError('Allow the sign-in window, then try again.'); return }
      child.opener = null
      setBusy('connect')
      const signal = lifetime.current.signal
      async function check() {
        if (signal.aborted) return
        try {
          const mail = await refresh(signal)
          if (signal.aborted) return
          if (mail.status === 'connected' || child.closed) {
            if (mail.status !== 'connected') setNotice('Outlook sign-in was not completed.')
            setBusy('')
            return
          }
        } catch {
          if (signal.aborted) return
          if (child.closed) { setError('Could not verify the connection. Refresh to check its status.'); setBusy(''); return }
        }
        timer.current = setTimeout(check, 1200)
      }
      void (async () => {
        try {
          const { url } = await mutate('connect', signal)
          const destination = new URL(url, location.href)
          const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)
          if (destination.protocol !== 'https:' && !(destination.protocol === 'http:' && loopback)) throw Error('Invalid sign-in destination.')
          child.location.replace(destination.href)
          timer.current = setTimeout(check, 700)
        } catch (error) {
          child.close()
          if (!signal.aborted) { setError(error.message); setBusy('') }
        }
      })()
    }
    async function disconnect() {
      const signal = lifetime.current.signal
      setBusy('disconnect')
      setError('')
      setNotice('')
      // Invalidate a status request started before the user clicked Disconnect.
      ++sequence.current
      try {
        await mutate('disconnect', signal)
        await refresh(signal)
      } catch (error) {
        if (!signal.aborted) setError(error.message)
      } finally {
        if (!signal.aborted) setBusy('')
      }
    }

    const connected = account?.status === 'connected'
    const reconnect = account?.status === 'reconnect'
    const fixture = account?.mode === 'local'
    const status = !account ? 'Loading…' : busy === 'connect' ? 'Waiting for sign-in…' : busy === 'disconnect' ? 'Disconnecting…'
      : connected ? 'Connected' : reconnect ? 'Reconnect required' : account.available ? 'Off' : 'Unavailable'
    return h('section', { className: 'ac-page', 'aria-labelledby': 'ac-title' },
      h('link', { rel: 'stylesheet', href: '/claims/assets/app-connections.css' }),
      h('div', { className: 'ac-content' },
        h('header', { className: 'ac-header' },
          h('h1', { id: 'ac-title', ref: heading, tabIndex: -1 }, 'App connections'),
          h('p', null, 'Choose which apps your agent can use.')),
        h('article', { className: 'ac-card', 'aria-labelledby': 'ac-outlook' },
          h('div', { className: 'ac-card-head' },
            h('span', { className: 'ac-art' }, h('img', { src: '/claims/assets/app-connections-mail.svg', width: 36, height: 36, alt: '' })),
            h('div', null, h('h2', { id: 'ac-outlook' }, 'Microsoft Outlook'),
              h('p', null, 'Search and read messages in your work mailbox.'))),
          h('div', { className: 'ac-card-controls' },
            h('span', { className: 'ac-control-label' }, 'Allow agent access'),
            h(Switch, { label: 'Allow agent access', checked: connected,
              disabled: !!busy || !account || (!connected && !account.available),
              onChange: () => { if (connected) void disconnect(); else { setError(''); setNotice(''); setConfirm(true) } } }),
            h('span', { role: 'status', className: 'ac-status' }, status),
            reconnect && h(Button, { size: 'sm', variant: 'ghost', disabled: !!busy, onClick: disconnect }, 'Disconnect')),
          connected && account.address && h('p', { className: 'ac-detail' }, account.address),
          h('p', { className: 'ac-detail' }, 'Disconnecting stops future reads. Earlier answers stay in Chat.'),
          fixture && h('p', { className: 'ac-detail' }, 'Local demo mailbox · synthetic messages'),
          account && !account.available && !connected && h('p', { className: 'ac-detail' }, 'Outlook connections are unavailable in this environment.')),
        notice && h('p', { role: 'status', className: 'ac-message' }, notice),
        error && h('div', { role: 'alert', className: 'ac-error' }, error, ' ',
          h(Button, { variant: 'outline', size: 'sm', onClick: reload }, 'Refresh'))),
      h(Modal, { open: confirm, title: 'Connect your agent to Outlook?', closeLabel: 'Close',
        description: fixture ? 'Allow your agent to search and read the synthetic messages in your local demo mailbox.'
          : 'Allow your agent to search and read email in your Microsoft work mailbox. You can disconnect it here at any time.',
        onClose: () => setConfirm(false),
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', 'data-modal-autofocus': true, onClick: () => setConfirm(false) }, 'Cancel'),
          h(Button, { variant: 'primary', onClick: connect }, fixture ? 'Continue to demo sign-in' : 'Continue to Microsoft')) }))
  }
}
