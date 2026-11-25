// Only these employee-facing operations cross from managed Chat to the claims application.
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const conversationId = new RegExp('^' + uuid + '$')
const getChatRoute = new RegExp('^/claims/api/chat/(bootstrap|search|conversations|documents/(?:WC-[0-9]{3}|CLM-[0-9]{6})|(conversation|source|events)/' + uuid + ')$')
const postChatRoute = new RegExp('^/claims/api/chat/(conversations|route|(scope|turn|reply)/' + uuid + ')$')
const sharedAsset = /^\/claims\/assets\/(action-review\.mjs|pdf-link\.mjs|claim-pdf\.(mjs|css)|pdf\.(worker\.)?min\.mjs|native-claims\.(mjs|css)|claim-scope\.mjs|claim-chat\.mjs|claim-chat\.css|widget-settings\.json|(?:open-cases|portfolio-summary|claim-timeline)\.widget\.json|wage-review\.bundle\.mjs|timeline-host\.mjs|widget-format\.mjs)$/

export function isClaimConversationId(value) {
  return typeof value === 'string' && conversationId.test(value)
}

export function isChatBridgeRoute(method, path) {
  if (/^\/claims\/api\/mail-chat\/[A-Za-z0-9_-]{1,128}$/.test(path)) return method === 'GET' || method === 'POST'
  if (method === 'GET' && (path === '/claims/api/connections' ||
    /^\/claims\/assets\/(app-connections\.(mjs|css)|app-connections-mail\.svg|outlook-chat\.mjs)$/.test(path))) return true
  if (method === 'POST' && /^\/claims\/api\/connections\/outlook-mail\/(connect|disconnect)$/.test(path)) return true
  if (/^\/claims\/api\/items\/(?:WC-\d{3}|CLM-\d{6})\/actions$/.test(path)) return method==='GET'
  if (/^\/claims\/api\/items\/(?:WC-\d{3}|CLM-\d{6})\/prepare$/.test(path) ||
    /^\/claims\/api\/proposals\/[a-f0-9-]{36}\/review$/.test(path)) return method==='POST'
  if (/^\/claims\/api\/operations\/[a-f0-9-]{36}\/reconcile$/.test(path)) return method==='POST'
  return method === 'GET' ? getChatRoute.test(path) || sharedAsset.test(path) || path === '/claims/view-pdf'
    : method === 'POST' && postChatRoute.test(path)
}

// Employee Workbench requests still pass through the Workbench session, CSRF and record checks.
const item = '[A-Za-z0-9_.:%-]+'
const getWorkbench = [
  /^(portfolio|portfolio-summary|adjusters|mailbox|status|evaluate|dataset)$/,
  new RegExp('^(items|sessions|evidence|operations)/' + item + '$'),
  new RegExp('^items/' + item + '/(sessions|juris|actions)$'),
  new RegExp('^(documents|media)/' + item + '/' + item + '$'),
]
const postWorkbench = [
  /^(assist|evaluate|fixtures|wages|showcase\/call)$/,
  new RegExp('^items/' + item + '/(claim|request|transfer|prepare|release|mcp)$'),
  new RegExp('^mailbox/' + item + '/(answer|read)$'),
  new RegExp('^decisions/' + item + '/(feedback|exposure)$'),
  new RegExp('^proposals/' + item + '/review$'),
  new RegExp('^operations/' + item + '/reconcile$'),
]
export function isWorkbenchBridgeRoute(method, path) {
  if (method === 'GET' && /^\/claims\/assets\/(workbench-panel\.mjs|workbench\.(mjs|css)|showcase\.mjs)$/.test(path)) return true
  if (!path.startsWith('/claims/api/')) return false
  const route = path.slice('/claims/api/'.length)
  // IDs may contain encoded colons. Never admit encoded path separators or punctuation.
  if (/%(?!3a)/i.test(route)) return false
  const routes = method === 'GET' ? getWorkbench : method === 'POST' ? postWorkbench : []
  return routes.some(pattern => pattern.test(route))
}
