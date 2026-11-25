import { randomUUID } from 'node:crypto'
import { DomainError, transaction } from '../domain/index.mjs'

const owner = 'tenant=$1 AND actor=$2 AND subject=$3 AND session_id=$4'
const scope = (p, id) => [p.tenantId, p.principalId, p.subject, id]

export function mailHistory(pool) {
  return {
    async turn(principal, session, id) {
      const { rows } = await pool.query(`SELECT request_id AS id, question, answer,version FROM cw_mail_turns
        WHERE ${owner} AND request_id=$5 AND state='completed'`, [...scope(principal, session), id])
      if (!rows.length) throw new DomainError(404, 'not_found')
      return rows[0]
    },
    async list(principal, session, before) {
      const { rows } = await pool.query(
        `SELECT request_id AS id, question, answer, created_at AS "createdAt" FROM cw_mail_turns
         WHERE ${owner} AND state='completed' AND ($5::uuid IS NULL OR (created_at,request_id) <
           (SELECT created_at,request_id FROM cw_mail_turns WHERE ${owner} AND request_id=$5::uuid))
         ORDER BY created_at DESC,request_id DESC LIMIT 51`, [...scope(principal, session), before || null])
      return rows.reverse()
    },
    async start(principal, session, request, question, version, readRef = null) {
      const keys = scope(principal, session)
      return transaction(pool, async db => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(keys)])
        await db.query(`UPDATE cw_mail_turns SET state='failed' WHERE ${owner}
          AND state='running' AND created_at < clock_timestamp() - interval '3 minutes'`, keys)
        const existing = (await db.query(`SELECT question, read_ref, state, answer FROM cw_mail_turns
          WHERE ${owner} AND request_id=$5`, [...keys, request])).rows[0]
        if (existing && (existing.question !== question || existing.read_ref !== readRef)) throw new DomainError(409, 'mail_request_conflict')
        if (existing?.state === 'completed') return { answer: existing.answer }
        const active = await db.query(`SELECT 1 FROM cw_mail_turns WHERE ${owner} AND state='running'`, keys)
        if (active.rowCount) throw new DomainError(409, 'mail_turn_busy')
        const attempt = randomUUID()
        await db.query(`INSERT INTO cw_mail_turns
          (tenant,actor,subject,session_id,request_id,attempt_id,question,state,version,read_ref)
          VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8,$9)
          ON CONFLICT(tenant,actor,subject,session_id,request_id) DO UPDATE
          SET attempt_id=EXCLUDED.attempt_id, state='running', created_at=clock_timestamp(),version=EXCLUDED.version`,
          [...keys, request, attempt, question, version, readRef])
        // Retain the last displayed order, including an empty search. Account reconnection creates a new version.
        const last = (await db.query(`SELECT result_refs FROM cw_mail_turns WHERE ${owner} AND version=$5
          AND state='completed' AND answer->>'kind'='search'
          AND ($6::jsonb IS NULL OR result_refs @> $6::jsonb) ORDER BY created_at DESC LIMIT 1`,
          [...keys, version, readRef ? JSON.stringify([{ref:readRef}]) : null])).rows[0]
        if (readRef && !last) throw new DomainError(409, 'mail_reference_missing')
        return { attempt, previous: last?.result_refs || [] }
      })
    },
    async finish(principal, session, request, attempt, answer, refs = [], db = pool) {
      const { rowCount } = await db.query(`UPDATE cw_mail_turns SET state=$7,answer=$8,result_refs=$9
        WHERE ${owner} AND request_id=$5 AND attempt_id=$6 AND state='running'`,
        [...scope(principal, session), request, attempt, answer ? 'completed' : 'failed',
          answer ? JSON.stringify(answer) : null, JSON.stringify(refs)])
      if (!rowCount && answer) throw new DomainError(409, 'mail_turn_interrupted')
    },
  }
}
