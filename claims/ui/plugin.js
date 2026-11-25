window.__ModuleLoader__.load({
  id: '@local/claims-workbench',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const departmentChat = '/?mode=workbench&assistant=open#workbench'
    const isDepartment = (name) => name === 'legal' || name === 'finance'
    async function openChat(signal) {
      let destination = '/auth/hosted-chat'
      try {
        const me = await fetch('/auth/me', { cache: 'no-store', signal })
        if (me.ok) {
          const { user } = await me.json()
          if (!signal?.aborted && isDepartment(user.department)) {
            location.replace(document.querySelector('meta[name="claims-shared-host"]') ? destination : departmentChat)
            return
          }
        }
        const shared = document.querySelector('meta[name="claims-shared-host"]')
        const companionRequested = new URL(location.href).searchParams.get('mode') === 'companion'
        if (me.ok && (!shared || companionRequested) && location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname) && location.port) {
          const companion = new URL(location.origin)
          companion.port = String(Number(location.port) + 1)
          const timeout = AbortSignal.timeout(1200)
          const present = await fetch(new URL('/desktop/presence', companion), {
            credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          })
          if (present.status === 204) {
            destination = new URL('/open-chat', companion).href
          }
        }
      } catch (error) { /* A failed presence check falls back to hosted Chat. */ }
      if (!signal?.aborted) location.replace(destination)
    }
    function Icon({ size = 18 }) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          'aria-hidden': true,
        },
        React.createElement('rect', { x: 3, y: 7, width: 18, height: 13, rx: 2 }),
        React.createElement('path', { d: 'M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M3 12h18m-10 0v2h2v-2' }),
      )
    }
    const Panel = React.lazy(async () => {
      try {
        const { createWorkbenchPanel } = await import('/claims/assets/workbench-panel.mjs')
        return { default: createWorkbenchPanel(React) }
      } catch {
        return { default: () => h('p', { role: 'alert' }, 'Workbench could not load. Refresh to retry.') }
      }
    })
    const Connections = React.lazy(() => import('/claims/assets/app-connections.mjs').then(module => ({
      default: module.createAppConnections(React, primitives),
    })).catch(() => ({ default: () => h('p', { role: 'alert' }, 'App connections could not load. Refresh to retry.') })))
    function StandaloneWorkbench() {
      return h(React.Suspense, { fallback: null }, h(Panel))
    }
    function ChatEntry() {
      React.useEffect(() => {
        const stop = new AbortController()
        void openChat(stop.signal)
        return () => stop.abort()
      }, [])
      return h('p', { role: 'status' }, 'Opening Agent Chat… ', h('a', { href: '/auth/hosted-chat' }, 'Continue to Chat'))
    }
    return {
      name: 'claims-workbench-client',
      inject: ['layout', 'slots'],
      apply(ctx) {
        if (location.pathname === '/chat') return
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'claims-chat-entry' }, ChatEntry))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'workbench' }, StandaloneWorkbench))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'workbench', order: -100, label: 'Workbench' },
            Icon,
          ),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'app-connections' }, () =>
          h(React.Suspense, { fallback: h('p', { role: 'status' }, 'Opening app connections…') }, h(Connections))))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'app-connections', order: -99, label: 'App connections',
        }, () => h(primitives.IconLinkOutlineRegular, { size: 18, 'aria-hidden': true })))
        const restore = () => {
          const workbench = new URL(location.href).searchParams.get('mode') === 'workbench' || location.hash === '#workbench'
          ctx.layout.selectPanel(location.hash === '#app-connections' ? 'app-connections' : workbench ? 'workbench' : 'claims-chat-entry')
        }
        restore()
        ctx.effect(() => {
          const unwatch = ctx.layout.panelInfo.subscribe(() => {
            const id = ctx.layout.panelInfo.getSnapshot().activePanelId
            if (!['app-connections', 'workbench'].includes(id) || location.hash === '#' + id) return
            const url = new URL(location.href)
            url.hash = id
            history.pushState(history.state, '', url)
          })
          window.addEventListener('popstate', restore)
          return () => { unwatch(); window.removeEventListener('popstate', restore) }
        }, 'claims: panel navigation')
      },
    }
  },
})
