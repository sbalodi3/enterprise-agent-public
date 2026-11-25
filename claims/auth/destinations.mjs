import { isClaimConversationId } from '../desktop-chat/claim-routes.mjs'
import { pdfReference, pdfViewerHref } from '../ui/pdf-link.mjs'

export function standardChatId(params) {
  if (params.size===1 && /^session-[A-Za-z0-9_-]{1,120}$/.test(params.get('session') || '')) return params.get('session')
}

export function chatTarget(params) {
  if (!params.size) return '/open-chat'
  if (params.size !== 1) return null
  const record = params.get('record')
  if (/^(?:FIN|MAT)-[0-9]{1,12}$/.test(record || '')) return '/chat?record=' + record
  const conversation = params.get('conversation')
  if (isClaimConversationId(conversation)) return '/open-claims-chat?conversation=' + conversation
  const claim = params.get('claim')?.toUpperCase()
  if (/^(?:WC-\d{3}|CLM-\d{6})$/.test(claim || '')) return '/open-claims-chat?claim=' + claim
  return params.get('claims') === '1' ? '/open-claims-chat' : null
}

// Only canonical, relative product destinations can be bound into an OIDC login flow.
export function resumeDestination(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  const u = new URL(value, 'http://local')
  if (['/auth/hosted-chat', '/chat'].includes(u.pathname) && !u.hash) {
    if (u.pathname === '/chat' && standardChatId(u.searchParams)) return u.pathname+u.search
    const entry = chatTarget(u.searchParams)
    if (!entry) return null
    return u.pathname + (entry === '/open-chat' ? '' : '?' + (entry.split('?')[1] || 'claims=1'))
  }
  if (u.pathname === '/claims/view-pdf') {
    const ref = pdfReference(u.searchParams)
    if (ref && (!u.hash || u.hash === '#nameddest=' + ref.anchorId)) return pdfViewerHref(ref)
  }
  return null
}

export function loginHref(target) {
  const destination = resumeDestination(target)
  return destination ? '/auth/login?' + new URLSearchParams({ resume: destination }) : '/auth/login'
}
