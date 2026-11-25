import { createHash, randomUUID } from 'node:crypto'
import { validateSnapshot } from '../cms-mcp/snapshot.mjs'
import { dailyActions, validHandlingCommand, applyHandling, permitsAction } from '../../domain/handling-actions.mjs'
import { claims } from '../data/scenario.mjs'

export class JurisError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
  }
}
const reject = (status, code) => {
  throw new JurisError(status, code)
}
const key = (v) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(v)
const sha256 = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const keysAre = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k))

// Include the original digest (which covers the Workbench approval context) and all
// destination fields in an independently computed replay fingerprint.
export function commandFingerprint(c) {
  if (
    !keysAre(c, ['operationId', 'claimId', 'expectedRevision', 'type', 'payload', 'payloadDigest']) ||
    !key(c.operationId) ||
    typeof c.claimId !== 'string' ||
    !/^(?:WC-\d{3}|CLM-\d{6})$/.test(c.claimId) ||
    !Number.isSafeInteger(c.expectedRevision) ||
    c.expectedRevision < 1 ||
    !sha256(c.payloadDigest)
  )
    reject(400, 'invalid_command')
  if (dailyActions.includes(c.type)) {
    if (!validHandlingCommand(c.type,c.payload)) reject(400,'invalid_command')
    return createHash('sha256').update(JSON.stringify([c.operationId,c.claimId,c.expectedRevision,c.type,c.payloadDigest,
      Object.entries(c.payload).sort(([a],[b]) => a.localeCompare(b))])).digest('hex')
  }
  const wage = c.type === 'record_wage_evidence'
  if (!wage && c.type !== 'file_intake_transcript') reject(400, 'invalid_command')
  const sourceKey = wage ? 'requestId' : 'intakeId'
  const fields = [sourceKey, 'documentId', 'anchorId', 'quote']
  if (wage) fields.push('artifactDigest')
  if (wage && c.claimId.startsWith('CLM-')) {
    fields.push('filing')
    if (!Array.isArray(c.payload?.filing) || !c.payload.filing.length || c.payload.filing.length>160 ||
      !c.payload.filing.every(line=>typeof line==='string' && line.length<=2000)) reject(400,'invalid_evidence')
  }
  const p = c.payload
  if (
    !keysAre(p, fields) ||
    ![p[sourceKey], p.documentId, p.anchorId].every(key) ||
    typeof p.quote !== 'string' ||
    !p.quote.trim() ||
    p.quote.length > 2000 ||
    p.quote.includes('\u0000') ||
    (wage
      ? p.documentId !== `wage-${p.requestId}` || !sha256(p.artifactDigest)
      : !/^IN-\d{3}$/.test(p.intakeId) || p.documentId !== `${p.intakeId}-call`)
  )
    reject(400, 'invalid_evidence')
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.operationId,
        c.claimId,
        c.expectedRevision,
        c.type,
        c.payloadDigest,
        ...fields.map((field) => p[field]),
      ]),
    )
    .digest('hex')
}

export async function initializeJuris(pool, snapshot = null) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('enterprise-demo:mock-juris:init-v1',0))")
    await db.query(`CREATE SCHEMA IF NOT EXISTS mock_juris;
      CREATE TABLE IF NOT EXISTS mock_juris.claims (
        id text PRIMARY KEY, dossier jsonb NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
        wage_evidence jsonb, intake_transcripts jsonb NOT NULL DEFAULT '[]');
      ALTER TABLE mock_juris.claims ADD COLUMN IF NOT EXISTS handling jsonb NOT NULL DEFAULT '{"notes":[],"diaries":[],"handlingPriority":"Routine","nextHandlingInstruction":""}';
      CREATE TABLE IF NOT EXISTS mock_juris.receipts (
        operation_id text PRIMARY KEY, claim_id text NOT NULL REFERENCES mock_juris.claims(id),
        fingerprint text NOT NULL, evidence jsonb NOT NULL, receipt jsonb NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS juris_intake_filing ON mock_juris.receipts ((evidence->>'intakeId')) WHERE evidence ? 'intakeId';
      CREATE UNIQUE INDEX IF NOT EXISTS juris_wage_filing ON mock_juris.receipts ((evidence->>'requestId')) WHERE evidence ? 'requestId';`)
    for (const { id, claimant, employer, site, incidentDate, jurisdiction } of claims) {
      await db.query('INSERT INTO mock_juris.claims(id,dossier) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        { id, claimant, employer, site, incidentDate, jurisdiction },
      ])
    }
    if (snapshot) for (const row of validateSnapshot(snapshot).rows) {
      await db.query('INSERT INTO mock_juris.claims(id,dossier) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [row.externalClaimNumber,{ ...row, id:row.externalClaimNumber }])
    }
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  } finally {
    db.release()
  }
}

export function jurisStore(pool) {
  return {
    async read(id) {
      const res = await pool.query(
        `SELECT dossier,handling,revision,wage_evidence AS "wageEvidence",intake_transcripts AS "intakeTranscripts",
        (SELECT COALESCE(jsonb_agg(receipt ORDER BY (receipt->>'revision')::int), '[]'::jsonb) FROM mock_juris.receipts WHERE claim_id=c.id) AS receipts
        FROM mock_juris.claims c WHERE c.id=$1`,
        [id],
      )
      if (!res.rowCount) reject(404, 'not_found')
      const { dossier, handling, ...state } = res.rows[0]
      return { ...dossier, ...handling, ...state }
    },
    async receipt(operationId) {
      const res = await pool.query('SELECT receipt FROM mock_juris.receipts WHERE operation_id=$1', [
        operationId,
      ])
      if (!res.rowCount) reject(404, 'not_found')
      return res.rows[0].receipt
    },
    async apply(c) {
      const fingerprint = commandFingerprint(c)
      const db = await pool.connect()
      try {
        await db.query('BEGIN')
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `mock-juris:operation:${c.operationId}`,
        ])
        const old = (
          await db.query('SELECT fingerprint,receipt FROM mock_juris.receipts WHERE operation_id=$1', [
            c.operationId,
          ])
        ).rows[0]
        if (old) {
          if (old.fingerprint !== fingerprint) reject(409, 'operation_conflict')
          await db.query('COMMIT')
          return old.receipt
        }
        const current = (
          await db.query('SELECT revision,dossier,handling FROM mock_juris.claims WHERE id=$1 FOR UPDATE', [c.claimId])
        ).rows[0]
        if (!current) reject(404, 'not_found')
        if (current.revision !== c.expectedRevision) reject(409, 'stale_revision')
        const receipt = {
          receiptId: `JR-${randomUUID()}`,
          operationId: c.operationId,
          claimId: c.claimId,
          type: c.type,
          payloadDigest: c.payloadDigest,
          previousRevision: current.revision,
          revision: current.revision + 1,
          appliedAt: new Date().toISOString(),
        }
        const daily = dailyActions.includes(c.type)
        if (!permitsAction({type:'claim',source_claim_status:current.dossier.sourceStatus},c.type,c.payload.category)) reject(409,'operation_conflict')
        const handling = daily && applyHandling(c.type,c.payload,current.handling,receipt)
        if (daily && !handling) reject(409,'operation_conflict')
        const field = daily ? 'handling=$3' :
          c.type === 'record_wage_evidence'
            ? 'wage_evidence=$3'
            : 'intake_transcripts=intake_transcripts || jsonb_build_array($3::jsonb)'
        await db.query(`UPDATE mock_juris.claims SET revision=$2, ${field} WHERE id=$1`, [
          c.claimId,
          receipt.revision,
          daily ? handling : c.payload,
        ])
        await db.query(
          'INSERT INTO mock_juris.receipts(operation_id,claim_id,fingerprint,evidence,receipt) VALUES($1,$2,$3,$4,$5)',
          [c.operationId, c.claimId, fingerprint, c.payload, receipt],
        )
        await db.query('COMMIT')
        return receipt
      } catch (err) {
        await db.query('ROLLBACK')
        if (err.code === '23505') reject(409, 'operation_conflict')
        throw err
      } finally {
        db.release()
      }
    },
  }
}
