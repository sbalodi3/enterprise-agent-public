// The host mounts only bundled, read-only claims apps.
export async function getTimeline(request, item) {
  const call = async (id, method, params = {}) => {
    const response = await request('items/' + encodeURIComponent(item.id) + '/mcp', {
      jsonrpc: '2.0',
      id,
      method,
      params,
    })
    if (response.error || response.id !== id) throw Error('Timeline resource is unavailable.')
    return response.result
  }
  await call(1, 'initialize', {
    protocolVersion: '2025-11-25',
    clientInfo: { name: 'enterprise-agent', version: '1.0.0' },
    capabilities: {
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
    },
  })
  await request('items/' + encodeURIComponent(item.id) + '/mcp', {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })
  const { tools } = await call(2, 'tools/list')
  const uri = tools.find((t) => t.name === 'claim_timeline')?._meta?.ui?.resourceUri
  if (uri !== 'ui://enterprise-agent/claim-timeline.html') throw Error('Unsupported timeline application.')
  const [resource, result] = await Promise.all([
    call(3, 'resources/read', { uri }).catch(() => null),
    call(4, 'tools/call', { name: 'claim_timeline', arguments: { expectedVersion: item.version } }),
  ])
  return { resource: resource?.contents?.[0], result, version: item.version }
}
export function mountTimeline(container, app, openSource, failed, mounted) {
  const data = app.result.structuredContent
  const references = [
    ...data.sources,
    ...data.events.filter((e) => e.document).map((e) => ({ id: e.document, anchorId: e.anchorId })),
  ]
  const sources = new Map(
    references.map((s) => [
      'urn:enterprise-agent:source:' + encodeURIComponent(s.id) + '#' + encodeURIComponent(s.anchorId),
      s,
    ]),
  )
  return mountReadOnlyApp(container, { ...app, name: 'claim-timeline', failed, mounted, title: 'Interactive claim timeline', className: 'cw-timeline-app',
    args: { expectedVersion: app.version }, links: sources, open: openSource })
}

export function mountCases(container, resource, data, openCase, failed) {
  const links = new Map(data.items.map(row => ['urn:enterprise-agent:claim:' + encodeURIComponent(row.id), row.id]))
  return mountReadOnlyApp(container, { resource, name: 'open-cases', failed, title: 'Interactive case list', className: 'cc-case-app',
    args: { view: data.view }, result: { structuredContent: data }, links, open: openCase })
}

export function mountSummary(container, resource, data, openCase, failed) {
  const links = new Map()
  for (const group of data.groups) for (const item of group.items) {
    links.set('urn:enterprise-agent:claim:' + encodeURIComponent(item.id), item.id)
  }
  return mountReadOnlyApp(container, { resource, name: 'portfolio-summary', failed, title: 'Interactive portfolio summary', className: 'cc-summary-app',
    args: { groupBy: data.groupBy }, result: { structuredContent: data }, links, open: openCase })
}

function mountReadOnlyApp(container, app) {
  const maxHeight = 440
  const frame = document.createElement('iframe')
  frame.title = app.title
  frame.className = app.className
  // Position the frame before presenting its interactive result. Otherwise the
  // initial scroll and resize can move a source link during the first click.
  frame.height = String(maxHeight)
  frame.style.visibility = 'hidden'
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  frame.referrerPolicy = 'no-referrer'
  let phase = 'proxy', origin
  const control = new AbortController()
  const preference = window.matchMedia('(prefers-color-scheme: dark)')
  function currentTheme() {
    const scheme = getComputedStyle(document.documentElement).colorScheme
    if (scheme === 'light' || scheme === 'dark') return scheme
    return preference.matches ? 'dark' : 'light'
  }
  let theme
  function syncTheme() {
    const next = currentTheme()
    if (phase === 'ready' && next !== theme) {
      theme = next
      post({ method: 'ui/notifications/host-context-changed', params: { theme } })
    }
  }
  const appearance = new MutationObserver(syncTheme)
  // A conversation can refresh behind Workbench. Confirm the viewport when it
  // becomes measurable, including when the employee returns to that conversation.
  const firstLayout = new ResizeObserver(() => {
    if (!frame.clientWidth || !frame.clientHeight) return
    firstLayout.disconnect()
    frame.style.visibility = ''
    post({ method: 'ui/notifications/host-context-changed', params: { containerDimensions: { height: frame.clientHeight } } })
  })
  const timer = setTimeout(unavailable, 5000)
  function dispose() {
    clearTimeout(timer)
    control.abort()
    appearance.disconnect()
    firstLayout.disconnect()
    if (phase === 'ready') post({ id: 'end', method: 'ui/resource-teardown', params: {} })
    window.removeEventListener('message', handle)
    frame.remove()
  }
  function unavailable() {
    if (control.signal.aborted) return
    dispose()
    app.failed?.()
  }
  const post = (m) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...m }, origin)
  function handle(e) {
    const m = e.data
    if (!frame.isConnected || e.source !== frame.contentWindow || e.origin !== origin || m?.jsonrpc !== '2.0')
      return
    if (m.method === 'ui/notifications/sandbox-proxy-ready' && phase === 'proxy') {
      phase = 'new'
      post({ method: 'ui/notifications/sandbox-resource-ready', params: { html: app.resource.text, csp: app.resource._meta?.ui?.csp ?? {}, permissions: app.resource._meta?.ui?.permissions ?? {} } })
      return
    }
    if (m.method === 'ui/initialize' && phase === 'new') {
      phase = 'starting'
      theme = currentTheme()
      post({
        id: m.id,
        result: {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'Enterprise Agent', version: '1.0.0' },
          hostCapabilities: { openLinks: {} },
          hostContext: { platform: 'web', theme, containerDimensions: { maxHeight } },
        },
      })
    } else if (m.method === 'ui/notifications/initialized' && phase === 'starting') {
      phase = 'ready'
      appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
      preference.addEventListener('change', syncTheme, { signal: control.signal })
      app.mounted?.(frame)
      syncTheme()
      post({ method: 'ui/notifications/tool-input', params: { arguments: app.args } })
      post({ method: 'ui/notifications/tool-result', params: app.result })
    } else if (phase === 'ready' && m.method === 'ui/notifications/size-changed') {
      const height = m.params?.height
      if (Number.isFinite(height)) {
        const border = frame.offsetHeight - frame.clientHeight
        frame.style.height = Math.max(60, Math.min(maxHeight, height + border)) + 'px'
        if (frame.style.visibility === 'hidden') {
          clearTimeout(timer)
          firstLayout.observe(frame)
        }
      }
    } else if (m.method === 'ui/open-link' && phase === 'ready' && app.links.has(m.params?.url)) {
      post({ id: m.id, result: {} })
      app.open(app.links.get(m.params.url))
    } else if (m.method && m.id !== undefined)
      post({ id: m.id, error: { code: -32601, message: 'Unavailable' } })
  }
  window.addEventListener('message', handle)
  void (async () => {
    if (app.resource?.uri !== 'ui://enterprise-agent/' + app.name + '.html' ||
        app.resource.mimeType !== 'text/html;profile=mcp-app' || typeof app.resource.text !== 'string')
      throw Error('Unknown claims widget')
    const response = await fetch('/claims/assets/widget-settings.json', { signal: control.signal })
    if (!response.ok) throw Error('Widget settings unavailable')
    const settings = await response.json()
    const url = new URL('/proxy', settings.origin)
    if (url.hostname === location.hostname || !['https:', 'http:'].includes(url.protocol)) throw Error('Invalid sandbox origin')
    origin = url.origin
    url.searchParams.set('parent', location.origin)
    if (control.signal.aborted) return
    frame.src = url.href
    container.append(frame)
  })().catch(unavailable)
  return dispose
}
