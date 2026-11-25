// Bundled into each isolated HTML resource. Only the parent can deliver a result.
function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text != null) element.textContent = text
  return element
}

function startWidget(render) {
  let ready = false, sequence = 1
  const send = message => parent.postMessage({ jsonrpc: '2.0', ...message }, '*')
  const reportHeight = () => {
    if (ready) send({ method: 'ui/notifications/size-changed', params: { height: Math.ceil(document.body.getBoundingClientRect().height) } })
  }
  const observer = new ResizeObserver(reportHeight)
  function applyTheme(context) {
    if (context?.theme === 'light' || context?.theme === 'dark') document.documentElement.style.colorScheme = context.theme
  }
  function open(url) {
    send({ id: ++sequence, method: 'ui/open-link', params: { url } })
  }
  addEventListener('message', event => {
    const message = event.data
    if (event.source !== parent || message?.jsonrpc !== '2.0') return
    if (message.id === 1 && message.result && !ready) {
      ready = true
      applyTheme(message.result.hostContext)
      // Our host confirms its measured viewport before the first result accepts
      // input. Other hosts can present the resource at their own fixed size.
      document.body.inert = message.result.hostInfo?.name === 'Enterprise Agent' &&
        !!message.result.hostContext?.containerDimensions?.maxHeight
      send({ method: 'ui/notifications/initialized' })
    } else if (message.method === 'ui/resource-teardown') {
      ready = false
      observer.disconnect()
      send({ id: message.id, result: {} })
    } else if (ready && message.method === 'ui/notifications/host-context-changed') {
      applyTheme(message.params)
      if (document.body.inert && message.params?.containerDimensions?.height) {
        requestAnimationFrame(() => { document.body.inert = false })
      }
    } else if (ready && message.method === 'ui/notifications/tool-result') {
      render(message.params.structuredContent, open)
      reportHeight()
      observer.observe(document.body)
    }
  })
  send({ id: 1, method: 'ui/initialize', params: {
    protocolVersion: '2026-01-26', appInfo: { name: document.title, version: '1.0.0' }, appCapabilities: {},
  } })
}

function claimButton(item, open, label) {
  const button = node('button', '', label)
  button.type = 'button'
  button.setAttribute('aria-label', ['Open ' + item.id, claimTitle(item), 'in Workbench'].filter(Boolean).join(' '))
  button.onclick = () => open('urn:enterprise-agent:claim:' + encodeURIComponent(item.id))
  return button
}
