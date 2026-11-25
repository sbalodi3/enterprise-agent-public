// This page is served only on the dedicated sandbox origin after the server validates the parent.
{
  const host = new URL(location.href).searchParams.get('parent')
  const send = message => parent.postMessage(message, host)
  let view
  addEventListener('message', event => {
    const m = event.data
    if (!m || m.jsonrpc !== '2.0' || (m.method !== undefined && typeof m.method !== 'string')) return
    if (event.source === parent && event.origin === host) {
      if (m.method === 'ui/notifications/sandbox-resource-ready') {
        if (view) return
        const { html, csp, permissions } = m.params || {}
        if (typeof html !== 'string' || !csp || Object.keys(permissions || {}).length ||
            !Object.entries(csp).every(([key, list]) => ['connectDomains','resourceDomains','frameDomains','baseUriDomains'].includes(key) && Array.isArray(list) && !list.length)) return
        view = document.createElement('iframe')
        view.title = 'Widget content'
        view.sandbox = 'allow-scripts'
        view.referrerPolicy = 'no-referrer'
        const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'"
        view.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '">' + html.replace(/^\s*<!doctype html>/i, '')
        document.body.append(view)
      } else if (!m.method?.startsWith('ui/notifications/sandbox-')) {
        view?.contentWindow.postMessage(m, '*') // The inner frame has an opaque origin.
      }
    } else if (view && event.source === view.contentWindow && event.origin === 'null' &&
               !m.method?.startsWith('ui/notifications/sandbox-')) send(m)
  })
  if (parent !== window) send({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} })
}
