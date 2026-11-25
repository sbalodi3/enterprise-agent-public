import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { cmsRevision, cmsSource, sha256, validateSnapshot } from './snapshot.mjs'
import { containerEngine } from '../../deploy/container-engine.mjs'

const exportRows = `SELECT json_agg(row_to_json(r) ORDER BY r."sourceClaimId") FROM (
  SELECT c.claim_id AS "sourceClaimId", c.claim_number AS "externalClaimNumber", c.policy_number AS "policyNumber",
    c.adjuster_id AS "sourceAdjusterId", concat_ws(' ',a.first_name,a.last_name) AS "sourceAdjuster",
    c.insured_id AS "insuredId", concat_ws(' ',i.first_name,i.last_name) AS insured,
    cl.client_id AS "clientId", cl.client_name AS client, cl.client_type AS "clientType",
    o.office_id AS "officeId", o.office_name AS office, o.region,
    l.lob_code AS "lineOfBusiness", l.lob_name AS "lineOfBusinessName", c.claim_status AS "sourceStatus",
    c.date_of_loss::text AS "incidentDate", c.date_reported::text AS "reportedDate", c.description_of_loss AS "lossDescription",
    c.billings_amount::text AS "billingsAmount", c.deductible_amount::text AS "deductibleAmount", c.is_litigated AS litigated
  FROM claim c JOIN adjuster a USING(adjuster_id) JOIN insured i USING(insured_id)
  JOIN client cl USING(client_id) JOIN office o USING(office_id) JOIN lineofbusiness l USING(lob_id)
) r;`

/** Evaluate the source SQL in an ephemeral PostgreSQL instance, isolated from both app databases. */
export function extractRows(checkout, engine = containerEngine()) {
  const sourceFile = name => execFileSync('git', ['-C', checkout, 'show', cmsRevision + ':db/initdb/' + name], { encoding: 'utf8' })
  const sql = ['\\o /dev/null', sourceFile('01_schema.sql'), sourceFile('02_seed.sql'), '\\o', exportRows].join('\n')
  const output = execFileSync(engine, [
    'run', '--rm', '-i', '--pull=never', '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:mode=1777',
    '--entrypoint', 'sh', 'docker.io/library/postgres:17', '-eu', '-c',
    `initdb -D /tmp/data --auth=trust --no-locale >/dev/null
pg_ctl -D /tmp/data -o "-k /tmp -c listen_addresses=''" -l /tmp/postgres.log -w start >/dev/null
exec psql -h /tmp -d postgres -X -qAt -v ON_ERROR_STOP=1`,
  ], { input: sql, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  return JSON.parse(output)
}

export function prepareCmsSnapshot(path, checkout, engine) {
  if (existsSync(path)) return validateSnapshot(JSON.parse(readFileSync(path, 'utf8')))
  if (!checkout) throw new Error('Set CMS_MCP_SOURCE to your CMS-MCP Git checkout to prepare the first local snapshot.')
  const rows = extractRows(checkout, engine)
  const snapshot = validateSnapshot({
    format: 1, source: cmsSource, revision: cmsRevision, extractedAt: new Date().toISOString(),
    digest: sha256(JSON.stringify(rows)), rows,
  })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, JSON.stringify(snapshot) + '\n', { flag: 'wx', mode: 0o644 })
  renameSync(temporary, path)
  return snapshot
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const snapshot = prepareCmsSnapshot(process.argv[2], process.env.CMS_MCP_SOURCE)
  console.log('CMS-MCP snapshot verified:', snapshot.rows.length, 'claims at', snapshot.revision)
}
