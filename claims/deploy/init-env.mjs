import { demoIssuer, upgradeIssuer } from './entra-upgrade.mjs'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const path = fileURLToPath(new URL('./.env', import.meta.url))
const secret = () => randomBytes(32).toString('hex')
await mkdir(fileURLToPath(new URL('./models', import.meta.url)), { recursive: true })
const values = {
  CLAIMS_POSTGRES_PASSWORD: secret(), CLAIMS_DB_PASSWORD: secret(),
  CLAIMS_OIDC_CLIENT_SECRET: secret(), CLAIMS_SESSION_SECRET: secret(), CLAIMS_WORKER_TOKEN: secret(), CLAIMS_FIXTURE_TOKEN: secret(),
  CLAIMS_APP_ORIGIN: 'http://localhost:3080', CLAIMS_OIDC_ISSUER: demoIssuer(false),
  CLAIMS_MODELS_DIR: './claims/deploy/models', CLAIMS_MODEL_FILE: 'Qwen3-4B-Q4_K_M.gguf',
}
try {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n') }
  finally { await handle.close() }
  console.log(`Created ${path}. Credentials are stored there with owner-only permissions; no secrets printed.`)
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  upgradeIssuer(path, false)
  const present = await readFile(path, 'utf8')
  if (!/^CLAIMS_FIXTURE_TOKEN=/m.test(present)) {
    const handle = await open(path, 'a', 0o600)
    try { await handle.writeFile(`${present.endsWith('\n') ? '' : '\n'}CLAIMS_FIXTURE_TOKEN=${secret()}\n`) }
    finally { await handle.close() }
    console.log('Appended the missing independently generated fixture token; existing settings preserved.')
  } else console.log(`${path} already exists; preserved existing credentials.`)
}
