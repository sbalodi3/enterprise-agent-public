import { loadConfig } from './dist/config/loadConfig.js'
import { openDatabase, transaction } from './dist/store/db.js'
import { runMigrations } from './dist/store/migrations/index.js'
import { createStore } from './dist/store/store.js'
import { systemClock } from './dist/store/util.js'
import { CMS_USERS, directory, workbenchClient } from './roster.mjs'

const roster = directory(process.env.CLAIMS_SHOWCASE === '1')
process.env.TENANT_ID = roster.tenant
const config = loadConfig()
const secret = process.env.CLAIMS_OIDC_CLIENT_SECRET
const callback = new URL('/auth/callback', process.env.CLAIMS_APP_ORIGIN).href
if (!secret || secret.length < 16 || config.seedOnStart !== false) throw new Error('Invalid workbench directory configuration')
const db = openDatabase(config.dbPath)
try {
  runMigrations(db, systemClock)
  const { tenants, users, apps } = createStore(db, config)
  transaction(db, () => {
    const existing = tenants.getDefault()
    if (existing && (existing.id !== roster.tenant || existing.issuer !== config.issuer))
      throw new Error('This directory volume belongs to a different issuer')
    tenants.upsert({ id: roster.tenant, issuer: config.issuer, displayName: 'Claims workbench' })
    for (const { objectId, upn, displayName } of roster.employees) {
      const account = users.getById(objectId)
      if ((account && (account.userPrincipalName !== upn || account.tenantId !== roster.tenant))
        || (users.getByUpn(upn) && !account)) throw new Error('Conflicting directory account for ' + upn)
      if (!account) users.create({ id: objectId, tenantId: roster.tenant, userPrincipalName: upn, displayName, mail: upn })
      else if (account.displayName !== displayName || !account.accountEnabled) users.update(objectId, { displayName, accountEnabled: true })
    }
    if (process.env.CLAIMS_SHOWCASE === '1' && process.env.CLAIMS_CMS_MCP !== '1') {
      for (const { objectId, upn } of CMS_USERS) {
        const existing = users.getById(objectId)
        if (existing?.userPrincipalName === upn && existing.accountEnabled) users.update(objectId, { accountEnabled: false })
      }
    }
    const client = apps.getByAppId(workbenchClient)
    if (!client) apps.create({ appId: workbenchClient, tenantId: roster.tenant, displayName: 'Claims workbench', isConfidential: true })
    else if (!client.isConfidential || client.tenantId !== roster.tenant) throw new Error('Conflicting workbench client registration')
    for (const redirect of apps.listRedirectUris(workbenchClient)) {
      if (redirect.uri !== callback || redirect.type !== 'web') apps.removeRedirectUri(workbenchClient, redirect.uri)
    }
    if (!apps.listRedirectUris(workbenchClient).length) apps.addRedirectUri(workbenchClient, callback, 'web')
    const secrets = apps.listSecrets(workbenchClient)
    if (secrets.length !== 1 || !apps.verifySecret(workbenchClient, secret)) {
      for (const old of secrets) apps.removeSecret(workbenchClient, old.id)
      apps.addSecret(workbenchClient, { plaintext: secret, displayName: 'Local workbench' })
    }
  })
} finally {
  db.close()
}
await import('./dist/index.js')
