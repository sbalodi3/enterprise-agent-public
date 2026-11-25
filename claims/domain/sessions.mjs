import { DomainError } from './index.mjs'

export async function migrateSessions(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS cw_claim_sessions (
    id text PRIMARY KEY, item_id text NOT NULL REFERENCES cw_items,
    tenant text NOT NULL, profile text NOT NULL, actor text NOT NULL, subject text NOT NULL,
    release text NOT NULL, revision integer NOT NULL, mode text NOT NULL, task text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    state text NOT NULL DEFAULT 'started', answer jsonb,
    FOREIGN KEY (tenant,profile,actor) REFERENCES cw_principals(tenant,profile,id)
  )`)
}
const header = (s) => ({
  sessionId: s.id,
  itemId: s.item_id,
  profileRelease: s.release,
  revision: s.revision,
  task: s.task,
  mode: s.mode,
  createdAt: new Date(s.created_at).toISOString(),
  state: s.state,
})
export function sessionRecords(run, visible) {
  async function owned(db, u, id) {
    const s = (
      await db.query(
        'SELECT * FROM cw_claim_sessions WHERE id=$1 AND tenant=$2 AND profile=$3 AND actor=$4 AND subject=$5',
        [id, u.tenant, u.profile, u.id, u.subject],
      )
    ).rows[0]
    if (!s) throw new DomainError(404, 'not_found')
    await visible(db, u, s.item_id)
    return s
  }
  return {
    bindSession(ctx, { sessionId, itemId, expectedVersion, mode, task, profileRelease }) {
      return run(ctx, async (db, u) => {
        const item = await visible(db, u, itemId, true)
        if (expectedVersion !== item.version) throw new DomainError(409, 'stale_version')
        await db.query(
          'INSERT INTO cw_claim_sessions(id,item_id,tenant,profile,actor,subject,release,revision,mode,task) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            sessionId,
            itemId,
            u.tenant,
            u.profile,
            u.id,
            u.subject,
            profileRelease,
            expectedVersion,
            mode,
            task,
          ],
        )
      })
    },
    finishSession(ctx, sessionId, result) {
      return run(ctx, async (db, u) => {
        const s = await owned(db, u, sessionId)
        const item = await visible(db, u, s.item_id, true)
        if (item.version !== s.revision) throw new DomainError(409, 'stale_version')
        await db.query(
          "UPDATE cw_claim_sessions SET answer=$2,state='completed' WHERE id=$1 AND state='started'",
          [sessionId, { text: result.text, sources: result.sources }],
        )
      })
    },
    // A crash leaves an interrupted start. No result is available until the
    // authenticated, still-authorized run committed its bounded answer.
    failSession(ctx, sessionId) {
      return run(ctx, (db, u) =>
        db.query(
          "UPDATE cw_claim_sessions SET state='interrupted' WHERE id=$1 AND actor=$2 AND tenant=$3 AND profile=$4 AND subject=$5 AND state='started'",
          [sessionId, u.id, u.tenant, u.profile, u.subject],
        ),
      )
    },
    sessions(ctx, itemId) {
      return run(
        ctx,
        async (db, u) => {
          await visible(db, u, itemId)
          const rows = await db.query(
            'SELECT * FROM cw_claim_sessions WHERE item_id=$1 AND actor=$2 AND tenant=$3 AND profile=$4 AND subject=$5 ORDER BY created_at DESC,id DESC LIMIT 30',
            [itemId, u.id, u.tenant, u.profile, u.subject],
          )
          return { items: rows.rows.map(header) }
        },
        true,
      )
    },
    session(ctx, sessionId) {
      return run(
        ctx,
        async (db, u) => {
          const s = await owned(db, u, sessionId)
          return { ...header(s), ...(s.answer || {}) }
        },
        true,
      )
    },
  }
}
