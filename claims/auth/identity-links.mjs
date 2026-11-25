import { transaction } from '../domain/index.mjs'

/** A repeated seed may reuse the exact link, but must never reassign a workspace or directory account. */
export async function provisionLinks(pool, { tenant, employees }) {
  await transaction(pool, async db => {
    for (const user of employees) {
      const values = [tenant, user.objectId, user.tenantId, user.profile, user.principalId, user.subject]
      try {
        await db.query(`INSERT INTO cw_entra_identities
          (entra_tenant_id,entra_object_id,tenant,profile,principal_id,subject)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, values)
        const result = await db.query(`SELECT 1 FROM cw_entra_identities WHERE
          (entra_tenant_id,entra_object_id,tenant,profile,principal_id,subject)=($1,$2,$3,$4,$5,$6)`, values)
        if (!result.rowCount) throw new Error('Conflicting employee link')
      } catch (cause) {
        throw new Error('Cannot provision Entra identity for ' + user.upn, { cause })
      }
    }
  })
}

/** Only an explicitly rostered account with its exact persisted employee assignment can sign in. */
export function employeeResolver(pool, roster) {
  const employees = new Map(roster.employees.map(user => [user.objectId, user]))
  return async (tid, oid) => {
    const entry = employees.get(oid)
    if (tid !== roster.tenant || !entry) return
    const { rows } = await pool.query(`SELECT p.role FROM cw_entra_identities l JOIN cw_principals p
      ON (p.tenant,p.profile,p.id)=(l.tenant,l.profile,l.principal_id)
      WHERE (l.entra_tenant_id,l.entra_object_id,l.tenant,l.profile,l.principal_id,l.subject)=($1,$2,$3,$4,$5,$6)`,
      [tid, oid, entry.tenantId, entry.profile, entry.principalId, entry.subject])
    if (!rows.length) return
    const { role } = rows[0]
    const department = entry.profile === 'legal-v1' ? 'legal' : entry.profile === 'finance-v1' ? 'finance' : undefined
    if (entry.role ? role !== entry.role : department ? role !== department : !['adjuster', 'supervisor'].includes(role)) return
    return { subject: entry.subject, tenantId: entry.tenantId, principalId: entry.principalId,
      displayName: entry.displayName, roles: Object.freeze([role]), ...(department && { department }) }
  }
}
