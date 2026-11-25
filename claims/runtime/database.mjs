import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { cmsSnapshotPath } from '../showcase/cms-mcp/snapshot.mjs'
import { migrate, seed } from '../domain/index.mjs'
import { createPortfolioStore } from '../portfolios/store.mjs'
import { provisionLinks } from '../auth/identity-links.mjs'
import { directory } from '../auth/roster.mjs'

export const name = 'claims-database'

/** Publish the shared pool only after the claim, department and identity records are ready. */
export async function apply(ctx) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the claims workbench')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, max: 10 })
  ctx.effect(() => () => pool.end(), 'claims: database pool')
  const showcase = process.env.CLAIMS_SHOWCASE === '1'
  await migrate(pool)
  const cmsSnapshot = showcase && process.env.CLAIMS_CMS_MCP === '1'
    ? JSON.parse(await readFile(process.env.CLAIMS_CMS_SNAPSHOT_FILE || cmsSnapshotPath, 'utf8'))
    : null
  await seed(pool, { showcase, cmsSnapshot })
  if (showcase) await createPortfolioStore(pool).seed()
  await provisionLinks(pool, directory(showcase))
  ctx.provide('claimsDatabase', pool)
}
