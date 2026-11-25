import { departmentProfiles } from './profiles.mjs'
import { DomainError } from '../domain/index.mjs'

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

const directory = `cw_entra_identities e JOIN cw_principals p
      ON (p.tenant,p.profile,p.id)=(e.tenant,e.profile,e.principal_id)`
const predicate = `r.deployment=e.entra_tenant_id AND r.subject=e.subject AND r.kind='session'
        AND r.native_id=$1 AND e.tenant=$2 AND e.subject=$3 AND e.principal_id=$4
        AND e.profile=$5 AND r.chat_profile=$6
        AND CASE WHEN $6='claims' THEN p.role IN ('adjuster','supervisor','claims_admin') ELSE p.role=$6 END`

function sessionKey(user, profile, id) {
  return [id, user.tenantId, user.subject, user.principalId, profile.storageProfile, profile.id]
}

async function selectedRecord(pool, key) {
  const { rows } = await pool.query(
    `SELECT r.department_record FROM cw_native_chat_resources r, ${directory} WHERE ${predicate}`,
    key,
  )
  if (!rows.length) throw new DomainError(404, 'chat_session_unavailable')
  return rows[0].department_record
}

export function requireEmployeeChatSession(pool, user, id) {
  const profile = user.department ? departmentProfiles[user.department] : { id: 'claims', storageProfile: 'claims-v1' }
  return selectedRecord(pool, sessionKey(user, profile, id))
}

// Resolve the native session and the current directory assignment on every protected turn.
export function createDepartmentChat(pool, store, assistant) {
  return async ({ user, profile, id, operation, write, input, recheck }) => {
    const key = sessionKey(user, profile, id)
    async function current() {
      recheck()
      return selectedRecord(pool, key)
    }
    const selected = await current()
    const params = {
      user,
      profile,
      recordId: selected,
      session: id,
      async recheck() {
        if ((await current()) !== selected) throw new DomainError(409, 'chat_scope_changed')
      },
    }
    async function changeScope(recordId) {
      const updated = await pool.query(
        `UPDATE cw_native_chat_resources r SET department_record=$7 FROM ${directory} WHERE ${predicate}
        AND r.department_record IS NOT DISTINCT FROM $8`,
        [...key, recordId, selected],
      )
      if (!updated.rowCount) throw new DomainError(409, 'chat_scope_changed')
    }
    if (write && operation === 'scope') {
      if (input.previous !== selected) throw new DomainError(409, 'chat_scope_changed')
      if (input.recordId !== null) {
        if (typeof input.recordId !== 'string') throw new DomainError(400, 'invalid_record')
        await store.detail(user, input.recordId)
      }
      await changeScope(input.recordId)
      return { recordId: input.recordId }
    }
    if (write && operation === 'ask') {
      if (input.recordId !== selected) throw new DomainError(409, 'chat_scope_changed')
      if (!uuid.test(input.requestId)) throw new DomainError(400, 'invalid_request_id')
      await assistant.ask({ ...params, question: input.question, requestId: input.requestId })
      return { saved: true }
    }
    if (write || operation) throw new DomainError(404, 'not_found')
    const records = await store.list(user)
    if (selected && !records.items.some((row) => row.id === selected)) {
      await changeScope(null)
      return {
        profile: profile.name,
        recordId: null,
        records: records.items.map(({ id, title }) => ({ id, title })),
        turns: [],
        actions: [],
      }
    }
    const record = selected ? await store.detail(user, selected) : null
    const [turns, workbench] = await Promise.all([
      assistant.history(params),
      assistant.history({ ...params, session: null }),
    ])
    await params.recheck()
    return {
      profile: profile.name,
      recordId: selected,
      records: records.items.map(({ id, title }) => ({ id, title })),
      turns: turns.items,
      workbenchTurns: workbench.items,
      actions: record?.actions ?? [],
      version: record?.version,
    }
  }
}
