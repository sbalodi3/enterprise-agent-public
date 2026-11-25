// Run inside the offline migration helper, with the old volume mounted read-only and
// a writable staging home and per-employee files volume. No engine access is needed.
import { text } from 'node:stream/consumers'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { join, resolve } from 'node:path'
import { directory } from '../auth/roster.mjs'
import { nativeOwnership } from '../shared-chat/ownership.mjs'
import { importEmployee, rollbackEmployee } from '../shared-chat/migration.mjs'
import { migrate } from '../domain/index.mjs'

const [mode,folder,principalId] = process.argv.slice(2)
if (!['import','rollback'].includes(mode) || !folder || !principalId) throw Error('Use import|rollback MANIFEST_DIRECTORY EMPLOYEE')
const input = folder === '-' ? JSON.parse(await text(process.stdin)) : undefined
const index = input?.index ?? JSON.parse(await readFile(join(resolve(folder),'index.json')))
if (index.issues?.length || !['claims-demo','enterprise-agent-showcase'].includes(index.project)) throw Error('Resolve inventory issues first')
const roster = directory(index.project==='enterprise-agent-showcase',true)
const record = index.records.find(row=>row.principalId===principalId)
const employee = roster.employees.find(person=>person.principalId===principalId)
if (!employee || !record || record.subject !== employee.subject || record.manifest !== record.subject+'.json') throw Error('Employee manifest mismatch')
const manifest = input?.manifest ?? JSON.parse(await readFile(join(resolve(folder),record.manifest)))
if (manifest.subject !== record.subject) throw Error('Employee subject mismatch')
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required for the target deployment')
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:3})
const lock = await pool.connect()
try {
  await lock.query('SELECT pg_advisory_lock(hashtext($1))',['native-chat-migration/'+roster.tenant])
  await migrate(pool)
  const link = await pool.query('SELECT 1 FROM cw_entra_identities WHERE (entra_tenant_id,entra_object_id,subject)=($1,$2,$3)',[roster.tenant,employee.objectId,employee.subject])
  if (!link.rowCount) throw Error('Directory identity not provisioned in destination database')
  const registry = await nativeOwnership(pool,roster.tenant)
  const args = { legacy:'/legacy', home:'/shared/harness', workspace:'/workspace', restored:'/restored',
    logicalHome:'/data/harness', deployment:roster.tenant, manifest, registry }
  const result = mode === 'import' ? await importEmployee(args) : await rollbackEmployee(args)
  console.log(mode,principalId,(result.logs ?? result.sessions).length,'native logs verified')
} finally { lock.release(true); await pool.end() }
