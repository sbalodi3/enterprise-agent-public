import { workbenchClient, directory } from './roster.mjs'
export { DEMO_USERS } from './roster.mjs'

/** Read deployment values without returning them to a browser or recording secrets in logs. */
export function configFromEnvironment(env = process.env) {
  const required = name => {
    const value = env[name]
    if (!value) throw new TypeError(`${name} is required`)
    return value
  }
  return {
    appOrigin: required('CLAIMS_APP_ORIGIN'),
    issuer: required('CLAIMS_OIDC_ISSUER'),
    internalOrigin: env.CLAIMS_OIDC_INTERNAL_ORIGIN,
    clientId: env.CLAIMS_OIDC_CLIENT_ID || workbenchClient,
    clientSecret: required('CLAIMS_OIDC_CLIENT_SECRET'),
    sessionSeconds: Number(env.CLAIMS_AUTH_SESSION_SECONDS || 1800),
    flowSeconds: 300,
    requestTimeoutMs: 10000,
    maxSessions: 256,
    sharedChat: env.CLAIMS_SHARED_CHAT === '1',
    tenant: directory(env.CLAIMS_SHOWCASE === '1').tenant,
  }
}
