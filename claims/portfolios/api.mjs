import { DomainError } from '../domain/index.mjs'
import { departmentProfiles } from './profiles.mjs'
import { renderDocumentPdf } from '../showcase/data/pdf.mjs'
import { STORY_AS_OF } from '../showcase/data/scenario.mjs'

/** Routes run after the host verifies the employee session, Origin, and CSRF token. */
export function createDepartmentApi({ store, assistant, handoffs, chat }) {
  return async function dispatch({ path, user, write, input, recheck, query, res }) {
    const [department, resource, id, operation, argument, ...extra] = path.split('/')
    if (
      !Object.hasOwn(departmentProfiles, department) ||
      user.department !== department ||
      (await store.bootstrap(user))?.department !== department
    )
      throw new DomainError(404, 'not_found')
    if (extra.length || (id && !/^[A-Za-z0-9-]{1,80}$/.test(id))) throw new DomainError(404, 'not_found')
    const profile = departmentProfiles[department]
    if (resource === 'chat' && chat && !argument) {
      return chat({ user, profile, id, operation, write, input, recheck })
    }
    if ((resource === 'ask' && !id) || (resource === 'records' && id && operation === 'ask' && !argument)) {
      const params = { user, profile, recordId: id ?? null, recheck }
      return write ? assistant.ask({ ...params, question: input.question }) : assistant.history(params)
    }
    if (!write && resource === 'mailbox' && !id) return { items: (await store.list(user)).mail }
    if (resource !== 'records') throw new DomainError(404, 'not_found')
    if (!write) {
      if (!id) return store.list(user)
      if (!operation) return store.detail(user, id)
      if (operation === 'sources' && argument) {
        const source = await store.source(user, id, argument)
        if (query.has('version') && query.get('version') !== String(source.version))
          throw new DomainError(409, 'stale_version')
        if (query.get('format') !== 'pdf') return source
        const pdf = renderDocumentPdf({
          ...source,
          itemId: id,
          department: department.toUpperCase(),
          source: source.id,
          anchors: source.passages,
          asOf: STORY_AS_OF,
          dateLabel: 'Demo snapshot',
        })
        recheck()
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-disposition': 'inline; filename="' + source.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf"',
        })
        res.end(pdf)
        return
      }
    } else if (id && operation === 'actions' && profile.actions.includes(argument)) {
      const detail = await store.act(user, id, { ...input, action: argument })
      handoffs.wake()
      return detail
    }
    throw new DomainError(404, 'not_found')
  }
}
