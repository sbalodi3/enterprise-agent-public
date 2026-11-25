window.__ModuleLoader__.load({
  id: '@local/claims-desktop-chat',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const Connections = React.lazy(() => import('/claims/assets/app-connections.mjs').then(module => ({
      default: module.createAppConnections(React, primitives),
    })).catch(() => ({ default: () => React.createElement('p', { role: 'alert' }, 'App connections could not load. Refresh to retry.') })))
    let leavingChat = false
    function leaveChat(destination) {
      leavingChat = true
      location.replace(destination)
    }
    return {
      inject: ['slots', 'layout', 'uiWorkspace', 'workspaces', 'sessions', 'conversation'],
      apply(ctx) {
        const shared = location.pathname === '/chat'
        const department = document.querySelector('meta[name="employee-chat-department"]')?.content
        if (!shared && document.querySelector('meta[name="claims-shared-host"]')) return
        const authUrl = name => shared ? '/auth/' + name : '/desktop/workbench/' + name
        const claimEntry = query => shared ? '/auth/hosted-chat' + (query || '?claims=1') : '/open-claims-chat' + query
        if (shared) {
          if (!department) {
            const Files = React.lazy(async()=>({default:(await import('/claims/assets/workspace-files.mjs')).workspaceFiles(React)}))
            ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'workspace-files'},()=>
              React.createElement(React.Suspense,{fallback:null},React.createElement(Files))))
            ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'workspace-files',order:-98,label:'Workspace files'},
              ()=>React.createElement('span',{'aria-hidden':true},'▤')))
          }
          const linkedSession = new URL(location.href).searchParams.get('session')
          if (!linkedSession && !location.search && !location.hash) ctx.effect(() => {
            const sessions = ctx.sessions.list, workspaces = ctx.workspaces.list
            let started = false, active = true
            const open = async () => {
              if (started || !active || sessions.getSnapshot().phase !== 'ready' || workspaces.getSnapshot().phase !== 'ready') return
              const workspace = workspaces.getSnapshot().items[0]
              if (!workspace) return
              started = true
              const blank = workspace?.sessionIds.find(id => sessions.getSnapshot().byId[id]?.blank)
              const id = blank || await ctx.sessions.create({workspaceId:workspace.workspaceId})
              if (active) {
                ctx.layout.beginNavigation()
                ctx.uiWorkspace.openSession(id)
              }
            }
            const attempt = () => { void open().catch(() => { started = false }) }
            const offSessions = sessions.subscribe(attempt), offWorkspaces = workspaces.subscribe(attempt)
            attempt()
            return () => { active=false; offSessions(); offWorkspaces() }
          }, 'shared chat: open employee conversation')
        }
        const workbenchKey = 'claims-workbench'
        const connectionsKey = 'app-connections'
        const panelHashes = new Map([[workbenchKey, 'workbench'], [connectionsKey, 'app-connections']])
        const panel = () => ctx.layout.panelInfo.getSnapshot().activePanelId
        const subscribePanel = callback => ctx.layout.panelInfo.subscribe(callback)
        const returnToChat = () => ctx.layout.selectPanel(null)
        const onSignOut = active => { leavingChat = active }
        let openConversation, returnFocus, previousPanel = panel(), restoring = false
        const positions = new Map()
        const resume = {
          read: subject => new URLSearchParams(positions.get(subject)),
          save(subject, params) {
            const position = new URLSearchParams()
            for (const key of ['record', 'view', 'source', 'anchor', 'queue']) {
              if (params.has(key)) position.set(key, params.get(key))
            }
            positions.set(subject, position.toString())
          },
        }
        let assetRevision = 0
        function Workbench() {
          const [View, setView] = React.useState(null)
          const [attempt, setAttempt] = React.useState(assetRevision)
          const [error, setError] = React.useState('')
          const section = React.useRef(null)
          const retryQuery = attempt ? '?retry=' + attempt : ''
          React.useEffect(() => {
            let active = true
            section.current?.focus({ preventScroll: true })
            import('/claims/assets/workbench-panel.mjs' + retryQuery).then(module => {
              if (active) setView(() => module.createWorkbenchPanel(React))
            }).catch(() => { if (active) setError('Workbench could not load.') })
            return () => { active = false }
          }, [retryQuery])
          const retry = () => { setError(''); setView(null); setAttempt(++assetRevision) }
          const fallback = () => React.createElement('div', { role: 'alert' },
            error || 'Workbench could not load.', ' ',
            React.createElement('button', { onClick: retry }, 'Retry'), ' ',
            React.createElement('button', { onClick: returnToChat }, 'Return to Chat'), ' ',
            React.createElement('button', { onClick: () => leaveChat(shared ? '/open-workbench' : '/desktop/open-workbench') }, 'Open standalone Workbench'))
          const openThread = async id => {
            try { await openConversation(id) }
            catch { setError('This conversation could not be opened.') }
          }
          return React.createElement('section', { ref: section, tabIndex: -1, 'aria-label': 'Claims workbench',
            style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
            error ? fallback() : View ? React.createElement(View, {
              embedded: true, resume, retryQuery, onSignOut, onOpenChat: openThread, onFailure: fallback,
            }) : React.createElement('div', { role: 'status' }, 'Opening Workbench…'))
        }
        ctx.effect(() => {
          const stop = new AbortController()
          let native, boot, failure, handoffSession, disabled = false, release = () => {}
          const url = new URL(location.href)
          const linked = url.hash === '#claim-chat' || (shared && (url.searchParams.has('conversation') || url.searchParams.has('claim') || url.searchParams.has('claims') || url.searchParams.has('record')))
          const target = { conversation: url.searchParams.get('conversation'), claim: url.searchParams.get('claim') }
          function failed(message, action = 'retry') {
            return Object.assign(new Error(message), { claimsFailure: { message, action } })
          }
          function recover() {
            if (!failure) return
            if (failure.action === 'login') {
              leavingChat = true
              const query = target.conversation ? '?conversation=' + encodeURIComponent(target.conversation)
                : target.claim ? '?claim=' + encodeURIComponent(target.claim) : ''
              location.assign(claimEntry(query))
            } else if (failure.action === 'workbench') ctx.layout.selectPanel(workbenchKey)
            else connect()
          }
          const status = () => failure && React.createElement('div', { className: 'cs-notice', role: 'alert' },
            failure.message, ' ', React.createElement('button', { type: 'button', onClick: recover },
              failure.action === 'login' ? 'Sign in' : failure.action === 'workbench' ? 'Open Workbench' : 'Retry'))
          const gate = {
            transcript: () => null, controls: status, chips: () => null,
            hasThread: () => false, isScoped: () => !disabled,
            preparingSession: id => linked && id !== handoffSession,
            async dispatch(id, ...args) {
              await boot
              if (linked && id !== handoffSession) return 'hold'
              if (disabled) return 'workspace'
              return native ? native.dispatch(id, ...args) : 'hold'
            },
          }
          async function configuration() {
            const response = await fetch('/claims/api/chat/bootstrap', { cache: 'no-store', signal: stop.signal })
            if (response.status === 401) throw failed('Your sign-in has ended.', 'login')
            if (response.status === 403) throw failed('Your account cannot open Claims Agent Chat.', 'workbench')
            if (!response.ok) throw failed('The claims service is unavailable.')
            const config = await response.json()
            if (config.enabled === false) {
              if (linked || target.conversation || target.claim) throw failed('Claims Agent Chat is unavailable in this profile.', 'workbench')
              return config
            }
            if (!config.enabled || !config.csrfToken) throw failed('Claims Agent Chat could not start.')
            return config
          }
          async function prepareHandoff() {
            if (!linked || handoffSession) return
            const ready = list => new Promise(resolve => {
              const check = () => { if (stop.signal.aborted || list.getSnapshot().phase === 'ready') {
                off(); stop.signal.removeEventListener('abort', check); resolve()
              } }
              const off = list.subscribe(check)
              stop.signal.addEventListener('abort', check, { once: true }); check()
            })
            await Promise.all([ready(ctx.workspaces.list), ready(ctx.sessions.list)])
            if (stop.signal.aborted) return
            const workspaces = ctx.workspaces.list.getSnapshot().items
            const personal = workspaces[0] || await ctx.workspaces.initializeDefault(stop.signal)
            if (!personal) throw failed('Choose a workspace, then retry.')
            // Reserve one session for the link so that delayed routing or a retry never moves a draft.
            let existing
            if (target.conversation) {
              const profile = await import('/claims/assets/native-claims.mjs')
              // Older application gateways expose the lookup on the companion instance.
              const lookup = profile.existingClaimsSession ?? profile.createNativeClaims(React, ctx).existing
              existing = lookup(target.conversation, ctx.sessions.list.getSnapshot().ids)
            }
            const id = existing || await ctx.sessions.create({ workspaceId: personal.workspaceId })
            if (stop.signal.aborted) return
            handoffSession = id
            ctx.uiWorkspace.openSession(id)
            release()
            release = ctx.conversation.installCompanion({ ...gate })
          }
          async function start() {
            const [config, prepared] = await Promise.allSettled([configuration(), prepareHandoff()])
            if (stop.signal.aborted) return
            if (config.status === 'rejected') throw config.reason
            if (prepared.status === 'rejected') throw prepared.reason
            if (!config.value.enabled) { disabled = true; release(); return }
            if (config.value.department) {
              if (config.value.department !== department || (linked && !url.searchParams.has('record'))) throw failed('Open your department Chat from Workbench.', 'workbench')
              const { departmentChat } = await import('/claims/assets/department-chat.mjs')
              if (stop.signal.aborted) return
              native = departmentChat(React, config.value)
              if (linked) {
                await native.bind(handoffSession, { record: url.searchParams.get('record') })
                if (stop.signal.aborted) return
                url.searchParams.delete('record')
                url.searchParams.set('session', handoffSession)
                history.replaceState(history.state, '', url)
              }
              release()
              release = ctx.conversation.installCompanion(native)
              return
            }
            const { createNativeClaims } = await import('/claims/assets/native-claims.mjs')
            if (stop.signal.aborted) return
            native = createNativeClaims(React, ctx, config.value.csrfToken, claimId => {
              resume.save(config.value.subject, new URLSearchParams({ record: claimId }))
              ctx.layout.selectPanel(workbenchKey)
            })
            if (linked) {
              await native.bind(handoffSession, target)
              if (stop.signal.aborted) return
              url.hash = ''; url.searchParams.delete('conversation'); url.searchParams.delete('claim')
              history.replaceState(history.state, '', url)
            }
            release()
            release = ctx.conversation.installCompanion(native)
          }
          function connect() {
            if (stop.signal.aborted || (boot && !failure)) return
            failure = undefined
            release()
            release = ctx.conversation.installCompanion({ ...gate })
            boot = start().catch(error => {
              if (stop.signal.aborted) return
              native = undefined
              failure = error?.claimsFailure ?? { message: 'The claims service is unavailable.', action: 'retry' }
              release()
              release = ctx.conversation.installCompanion({ ...gate })
            })
          }
          let opening
          openConversation = async target => {
            if (opening) return opening
            const signal = ctx.layout.beginNavigation()
            const open = async () => {
              await boot
              if ((Object.hasOwn(target, 'record') || target.claim || target.conversation) && (!native || disabled)) throw new Error('Claims Chat is unavailable.')
              const check = () => { signal.throwIfAborted(); stop.signal.throwIfAborted() }
              check()
              const sessions = ctx.sessions.list.getSnapshot()
              let id = native?.existing(target.conversation, sessions.ids)
              if (!id) {
                const current = Object.values(sessions.byId).find(session => session.retainedBy.mainView > 0)
                const workspaces = ctx.workspaces.list.getSnapshot().items
                const workspace = workspaces.find(item => item.sessionIds.includes(current?.id)) ||
                  workspaces[0] || await ctx.workspaces.initializeDefault(signal)
                check()
                if (!workspace) throw new Error('Choose a workspace.')
                id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
              }
              check()
              await native?.bind(id, target, true)
              check()
              ctx.uiWorkspace.openSession(id)
            }
            opening = open().finally(() => { opening = undefined })
            return opening
          }
          connect()
          const styles = ['claim-chat.css','native-claims.css'].map(file => {
            const link = document.createElement('link')
            link.rel = 'stylesheet'; link.href = '/claims/assets/' + file
            document.head.append(link); return link
          })
          return () => { stop.abort(); release(); styles.forEach(link => link.remove()) }
        }, 'desktop chat: scoped conversation transport')
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'claims-workbench' }, Workbench))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'claims-workbench', order: -100, label: 'Workbench',
        }, () => React.createElement('span', { 'aria-hidden': true }, '▤')))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: connectionsKey }, () =>
          React.createElement(React.Suspense, { fallback: React.createElement('p', { role: 'status' }, 'Opening app connections…') },
            React.createElement(Connections))))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: connectionsKey, order: -99, label: 'App connections',
        }, () => React.createElement(primitives.IconLinkOutlineRegular, { size: 18, 'aria-hidden': true })))
        function SidebarActions({ wide }) {
          const activePanel = React.useSyncExternalStore(subscribePanel, panel)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState('')
          async function signOut() {
            setBusy(true)
            setError('')
            try {
              const response = await fetch(authUrl('me'), { cache: 'no-store' })
              if (response.ok) {
                const { csrfToken } = await response.json()
                leavingChat = true
                const result = await fetch(authUrl('logout'), { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } })
                if (!result.ok && result.status !== 401) throw new Error('Sign-out failed.')
              } else if (response.status !== 401) throw new Error('Sign-out is unavailable.')
              leaveChat(authUrl('signed-out'))
            } catch (error) {
              leavingChat = false
              setError('Could not sign out. Try again.')
              setBusy(false)
            }
          }
          return React.createElement('div', { className: 'cs-nav-actions' },
            panelHashes.has(activePanel) && React.createElement('button', {
              type: 'button', className: 'cs-nav-action', title: 'Return to chat', 'aria-label': 'Return to chat', onClick: returnToChat,
            }, wide ? 'Return to chat' : '↩'),
            !panelHashes.has(activePanel) && React.createElement('button', {
              type: 'button', className: 'cs-nav-action', title: 'Sign out', 'aria-label': 'Sign out', disabled: busy, onClick: signOut,
            }, wide ? 'Sign out' : '⇥'),
            error && React.createElement('p', { className: 'cs-nav-error', role: 'alert' }, error))
        }
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'claims-navigation', order: 0,
        }, SidebarActions))
        ctx.effect(() => {
          const release = [...panelHashes.keys()].map(key => ctx.layout.retainConversationFor?.(key))
          const followHistory = () => {
            restoring = true
            try {
              const requested = [...panelHashes].find(([, hash]) => location.hash === '#' + hash)
              if (requested) ctx.layout.selectPanel(requested[0])
              else if (panelHashes.has(panel())) returnToChat()
            } finally { restoring = false }
          }
          const unwatch = ctx.layout.panelInfo.subscribe(() => {
            const next = panel()
            if (next === previousPanel) return
            const wasRetained = panelHashes.has(previousPanel)
            previousPanel = next
            if (!panelHashes.has(next) && !wasRetained) return
            if (panelHashes.has(next) && !wasRetained) returnFocus = document.querySelector('[data-composer-card] [contenteditable=true]')
            else if (next === null) requestAnimationFrame(() => {
              if (panel() === null) returnFocus?.focus({ preventScroll: true })
            })
            if (!restoring) {
              const url = new URL(location.href)
              url.hash = panelHashes.get(next) ?? (url.searchParams.has('conversation') ? 'claim-chat' : '')
              history.pushState(history.state, '', url)
            }
          })
          window.addEventListener('popstate', followHistory)
          followHistory()
          return () => { window.removeEventListener('popstate', followHistory); unwatch(); release.forEach(dispose => dispose?.()); positions.clear() }
        }, 'desktop chat: Workbench navigation')
        ctx.effect(() => {
          const controller = new AbortController()
          const departing = () => { leavingChat = true }
          const restored = event => {
            if (event.persisted) { leavingChat = false; location.reload() }
          }
          window.addEventListener('pagehide', departing)
          window.addEventListener('pageshow', restored)
          const options = { signal: controller.signal, cache: 'no-store' }
          let retry
          const stopped = () => controller.signal.aborted || leavingChat
          async function followLogin() {
            if (stopped()) return
            try {
              const response = await fetch(shared ? '/auth/session-watch' : '/desktop/session-watch', options)
              if (response.ok) {
                const reader = response.body.getReader()
                while (!(await reader.read()).done) { /* Wait for the server to end the session. */ }
              }
            } catch { /* Sleep and network interruptions can stop the stream. */ }
            if (stopped()) return
            const status = await fetch(authUrl('me'), options).then(response => response.status, () => undefined)
            if (stopped()) return
            if (status !== 401 && status !== 403) {
              retry = setTimeout(followLogin, 2000)
              return
            }
            const target = new URL(location.href).searchParams.get('conversation')
            if (target && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target)) {
              leavingChat = true
              location.replace(claimEntry('?conversation=' + encodeURIComponent(target)))
            } else leaveChat(authUrl('signed-out'))
          }
          void followLogin()
          return () => {
            window.removeEventListener('pagehide', departing); window.removeEventListener('pageshow', restored)
            clearTimeout(retry)
            controller.abort()
          }
        }, 'desktop chat: follow application login')
        if (location.hash === '#new-desktop-session') {
          history.replaceState(history.state, '', location.pathname + location.search)
          // Match the sidebar action after the host publishes its workspace and session lists.
          ctx.effect(() => {
            const workspaces = ctx.workspaces.list
            const sessions = ctx.sessions.list
            let pending = true
            const start = () => {
              if (!pending || workspaces.getSnapshot().phase !== 'ready' || sessions.getSnapshot().phase !== 'ready') return
              pending = false
              // On first use the native client is already creating its default workspace.
              if (workspaces.getSnapshot().items.length && Object.keys(sessions.getSnapshot().byId).length) {
                ctx.uiWorkspace.startSession()
              }
            }
            const offWorkspaces = workspaces.subscribe(start)
            const offSessions = sessions.subscribe(start)
            start()
            return () => { offWorkspaces(); offSessions() }
          }, 'desktop chat: open new session')
        }
      },
    }
  },
})
