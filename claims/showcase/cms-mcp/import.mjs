import { CMS_USERS } from '../../auth/roster.mjs'
import { cmsRevision, cmsSource, sha256, validateSnapshot } from './snapshot.mjs'

const source = 'CMS-MCP synthetic claim extract'
const sourceAdjusters = new Map(CMS_USERS.filter(user => user.sourceAdjusterId).map(user => [user.sourceAdjusterId, user]))

export function extractDocument(row, extractedAt) {
  const { externalClaimNumber: id, lineOfBusinessName, lineOfBusiness, policyNumber, sourceStatus } = row
  return {
    id: id + '-extract', itemId: id, title: id + ' claim extract', kind: 'Synthetic claim extract',
    version: 1, asOf: extractedAt, dateLabel: 'Extracted', source,
    anchors: [
      { id: 'identity', label: 'Claim and policy', text: `Claim ${id}. Policy ${policyNumber}. Line of business: ${lineOfBusinessName} (${lineOfBusiness}). Source status: ${sourceStatus}.` },
      { id: 'assignment', label: 'People and office', text: `Source adjuster: ${row.sourceAdjuster} (ID ${row.sourceAdjusterId}). Insured: ${row.insured}. Client: ${row.client}. Office: ${row.office}, ${row.region}.` },
      { id: 'dates', label: 'Loss and report dates', text: `Loss date: ${row.incidentDate}. Reported date: ${row.reportedDate}.` },
      { id: 'loss', label: 'Loss description', text: row.lossDescription },
      { id: 'financials', label: 'Billings, deductible and litigation', text: `Billings: ${row.billingsAmount}. Deductible: ${row.deductibleAmount}. Litigated: ${row.litigated ? 'Yes' : 'No'}.` },
    ],
  }
}

async function seedPrincipal(db, id, role) {
  await db.query("INSERT INTO cw_principals (id,tenant,profile,role) VALUES ($1,'demo','claims-v1',$2) ON CONFLICT DO NOTHING", [id, role])
  const check = await db.query("SELECT 1 FROM cw_principals WHERE tenant='demo' AND profile='claims-v1' AND id=$1 AND role=$2", [id, role])
  if (!check.rowCount) throw new Error('Conflicting CMS-MCP demo principal: ' + id)
}

/** Called in the showcase seed transaction. Re-enable the pinned snapshot without changing any transfers or revisions. */
export async function seedCmsDataset(db, snapshot) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('cms-mcp:dataset',0))")
  if (!snapshot) {
    await db.query("UPDATE cw_datasets SET active=false WHERE id='cms-mcp' AND active")
    return
  }
  validateSnapshot(snapshot)
  const prior = (await db.query("SELECT snapshot_digest,source_revision FROM cw_datasets WHERE id='cms-mcp'")).rows[0]
  if (prior) {
    if (prior.snapshot_digest !== snapshot.digest || prior.source_revision !== cmsRevision)
      throw new Error('CMS-MCP source revision differs from the installed snapshot. A versioned upgrade is required.')
    await db.query("UPDATE cw_datasets SET active=true WHERE id='cms-mcp' AND NOT active")
    return
  }
  for (const user of CMS_USERS) await seedPrincipal(db, user.principalId, user.role)
  for (const row of snapshot.rows) {
    const id = row.externalClaimNumber
    const assignee = sourceAdjusters.get(row.sourceAdjusterId)
    if (assignee?.displayName !== row.sourceAdjuster) throw new Error('CMS-MCP directory mismatch for ' + id)
    const lifecycle = ['Open', 'Under Investigation'].includes(row.sourceStatus) ? 'open' : 'closed'
    const doc = extractDocument(row, snapshot.extractedAt)
    await db.query(`INSERT INTO cw_items
      (id,tenant,profile,owner_id,type,title,state,reason,next_action,as_of,source,lifecycle,
       external_claim_number,policy_number,line_of_business,source_claim_status)
      VALUES ($1,'demo','claims-v1',$2,'claim',$3,'review',$4,$5,$6,$7,$8,$1,$9,$10,$11)`, [
      id, assignee.principalId, row.lineOfBusinessName + ' · ' + id, row.lossDescription,
      'View source extract', snapshot.extractedAt, source, lifecycle, row.policyNumber, row.lineOfBusiness, row.sourceStatus,
    ])
    const facts = { ...row, candidateIds: [], sourceDataset: 'cms-mcp', sourceRevision: cmsRevision, sourceRepository: cmsSource,
      sourceRowDigest: sha256(JSON.stringify(row)), snapshotDigest: snapshot.digest, extractedAt: snapshot.extractedAt }
    await db.query('INSERT INTO cw_showcase_records(item_id,facts) VALUES ($1,$2)', [id, facts])
    await db.query('INSERT INTO cw_evidence(id,item_id,source,title,body,as_of,document) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [doc.id, id, source, doc.title, doc.anchors.map(a => a.text).join('\n'), doc.asOf, doc])
    await db.query(`INSERT INTO cw_events(id,item_id,kind,summary,at,source,evidence_id,anchor_id) VALUES
      ($1||'-loss',$1,'claim.loss-date','Date of loss',$2::date::timestamp AT TIME ZONE 'UTC',$5,$6,'dates'),
      ($1||'-reported',$1,'claim.report-date','Date reported',$3::date::timestamp AT TIME ZONE 'UTC',$5,$6,'dates'),
      ($1||'-received',$1,'document.received',$7,$4::timestamptz,$5,$6,'identity')`,
      [id, row.incidentDate, row.reportedDate, doc.asOf, source, doc.id, doc.title])
  }
  await db.query(`INSERT INTO cw_datasets(id,active,source_revision,snapshot_digest,extracted_at)
    VALUES ('cms-mcp',true,$1,$2,$3)`, [cmsRevision, snapshot.digest, snapshot.extractedAt])
}
