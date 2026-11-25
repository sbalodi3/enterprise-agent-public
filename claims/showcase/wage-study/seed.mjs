import pg from 'pg'
import { transaction } from '../../domain/index.mjs'
import { seedWageStudy } from '../../domain/showcase.mjs'

if (process.env.CLAIMS_SHOWCASE !== '1' || process.env.CLAIMS_WAGE_REVIEW !== '1')
  throw Error('Run inside the synthetic Workbench showcase with the wage review pilot enabled.')
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL})
try { await transaction(pool, seedWageStudy); console.log('Wage study cases WC-951 through WC-958 are available to Maya.') }
finally { await pool.end() }
