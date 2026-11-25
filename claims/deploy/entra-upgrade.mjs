import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { directory } from '../auth/roster.mjs'

export function demoIssuer(showcase) {
  const origin = showcase ? 'http://127.0.0.1:8180' : 'http://localhost:8080'
  return origin + '/' + directory(showcase).tenant + '/v2.0'
}

/** Translate the generated issuer in place while preserving private settings and file permissions. */
export function upgradeIssuer(path, showcase) {
  const original = readFileSync(path, 'utf8')
  const issuer = demoIssuer(showcase)
  const old = new URL(issuer).origin + '/realms/claims-demo'
  const updated = original.split('\n').map(line => line.trimEnd() === 'CLAIMS_OIDC_ISSUER=' + old
    ? 'CLAIMS_OIDC_ISSUER=' + issuer : line).join('\n')
  if (updated !== original) {
    const temp = path + '.' + randomUUID()
    writeFileSync(temp, updated, { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  }
}

/** Release the old issuer port for this Compose project, without removing containers or data. */
export function stopLegacyIssuer(project, engine) {
  const ids = execFileSync(engine, ['ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
    '--filter', 'label=com.docker.compose.service=keycloak'], { encoding: 'utf8' }).trim()
  if (!ids) return
  try {
    execFileSync(engine, ['image', 'inspect', 'claims-entra-local:0.1.1'], { stdio: 'ignore' })
  } catch (cause) {
    throw new Error('Build the Entra Local demo image before upgrading with --offline or --no-build.', { cause })
  }
  execFileSync(engine, ['stop', ...ids.split('\n')], { stdio: 'inherit' })
}
