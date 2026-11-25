import { createEmulator } from '@inbox-zero/emulate'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { startGraphFixture } from './graph-fixture.mjs'
import { directory } from '../../auth/roster.mjs'
import { validateSnapshot } from '../../showcase/cms-mcp/snapshot.mjs'

const cmsSnapshotFile = new URL('../../../.artifacts/claims-showcase/cms-mcp/snapshot.json', import.meta.url)
const sampleReferences = new Map([
  ['CLM-000020', 'AK-020-REVIEW'],
  ['CLM-000017', 'BL-017-REVIEW'],
])
const invoiceReferences = new Map([['maya', 'MAYA-141'], ['alex', 'ALEX-821'], ['finance', 'FIN-207'], ['legal', 'MAT-017']])

function claimMessages(row, employee) {
  const { externalClaimNumber: claim, lineOfBusinessName, sourceStatus, incidentDate, reportedDate, lossDescription } = row
  const reference = sampleReferences.get(claim) ?? claim + '-REVIEW'
  const shared = { user_email: employee.upn, body_content_type: 'text' }
  return [
    { ...shared, id: claim + '-correspondence', subject: claim + ' correspondence',
      body_content: [
        'The synthetic correspondence reference for ' + claim + ' is ' + reference + '.',
        lineOfBusinessName + ' claim. Date of loss: ' + incidentDate + '. Date reported: ' + reportedDate + '.',
        lossDescription,
      ].join('\n'),
      from: { name: 'Review Desk', address: 'review@example.test' }, received_date_time: '2026-11-01T15:00:00Z' },
    { ...shared, id: claim + '-update', subject: claim + ' review update',
      body_content: 'The imported status for ' + claim + ' is ' + sourceStatus + '. The correspondence is filed under reference ' + reference + '.',
      from: { name: 'Operations', address: 'ops@example.test' }, received_date_time: '2026-11-19T15:00:00Z' },
  ]
}

function invoiceMessages(employee) {
  const shared = { user_email: employee.upn, body_content_type: 'text' }
  const i = [...invoiceReferences.keys()].indexOf(employee.principalId)
  return [
    { ...shared, id: 'invoice-' + i, is_read: true, subject: 'Westfield invoice',
      body_content: 'The Westfield invoice reference is ' + invoiceReferences.get(employee.principalId) + '.',
      from: { name: 'Payroll', address: 'payroll@example.test' }, received_date_time: '2026-11-01T15:00:00Z' },
    { ...shared, id: 'draft-' + i, is_draft: true, is_read: false, subject: 'Unsent draft',
      body_content: 'A draft outside the inbox.', received_date_time: '2026-11-16T15:00:00Z' },
    { ...shared, id: 'update-' + i, subject: 'Operations update',
      body_content: 'Westfield operations have a new invoice schedule.',
      from: { name: 'Operations', address: 'ops@example.test' }, received_date_time: '2026-11-19T15:00:00Z' },
  ]
}

/** Start a loopback-only Microsoft service and bind each mailbox to its rostered employee. */
export async function startMailLab(appOrigin, { docker = false, containerHost, port = 0, hostname = '127.0.0.1', baseUrl, graphPort = 0, cms = false, showcase = cms, cmsSnapshot } = {}) {
  const application = new URL(appOrigin)
  if (application.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(application.hostname)) throw new Error('Expected a loopback application origin')
  const roster = directory(showcase, cms)
  const baselineOwners = roster.employees.filter(employee => invoiceReferences.has(employee.principalId))
  const adjusters = new Map(roster.employees.filter(employee => employee.sourceAdjusterId)
    .map(employee => [employee.sourceAdjusterId, employee]))
  const owners = [...baselineOwners, ...adjusters.values()]
  const messages = baselineOwners.flatMap(invoiceMessages)
  if (cms) {
    const snapshot = validateSnapshot(cmsSnapshot ?? JSON.parse(await readFile(
      process.env.CLAIMS_CMS_TEST_SNAPSHOT || cmsSnapshotFile, 'utf8')))
    for (const row of snapshot.rows) {
      const employee = adjusters.get(row.sourceAdjusterId)
      if (employee?.displayName !== row.sourceAdjuster) throw new Error('CMS-MCP directory mismatch for ' + row.externalClaimNumber)
      messages.push(...claimMessages(row, employee))
    }
  }
  const tenant = roster.tenant, client = randomUUID(), secret = randomBytes(32).toString('hex')
  const users = owners.map(u => ({ email: u.upn, tenant_id: tenant, name: u.displayName }))
  const tokens = Object.fromEntries(users.map(u => [randomUUID(), { login: u.email, scopes: ['User.Read'] }]))
  const emulator = await createEmulator({ service: 'microsoft', port, hostname, baseUrl,
    seed: { tokens, microsoft: { users, messages, oauth_clients: [{ client_id: client, client_secret: secret,
      redirect_uris: [application.origin + '/claims/connections/microsoft/callback'], tenant_id: tenant }] } } })
  const listenOrigin = 'http://127.0.0.1:' + (port || new URL(emulator.url).port)
  let graph
  try {
    graph = await startGraphFixture(listenOrigin, { hostname, port: graphPort })
    const map = {}
    for (const [i, token] of Object.keys(tokens).entries()) {
      // Bootstrap the emulator's randomly generated directory IDs using local fixture credentials.
      const res = await fetch(listenOrigin + '/v1.0/me', { headers: { authorization: 'Bearer ' + token } })
      const user = await res.json()
      if (!res.ok || !user.id || user.userPrincipalName !== users[i].email) throw new Error('Could not provision synthetic employee')
      map[owners[i].tenantId + '/' + owners[i].subject] = user.id
    }
    const host = containerHost ?? (docker ? 'host.docker.internal' : undefined)
    const internal = url => host ? 'http://' + host + ':' + new URL(url).port : url
    return { emulator: { url: emulator.url, close: async () => { await graph.close(); await emulator.close() } }, owners, users, env: {
      CLAIMS_APP_ORIGIN: application.origin, CLAIMS_MS_MODE: 'emulator', CLAIMS_MS_TENANT_ID: tenant,
      CLAIMS_MS_CLIENT_ID: client, CLAIMS_MS_CLIENT_SECRET: secret, CLAIMS_MS_ACCOUNT_MAP: JSON.stringify(map),
      CLAIMS_MS_TOKEN_KEY: randomBytes(32).toString('base64'), CLAIMS_MS_AUTHORITY_ORIGIN: emulator.url,
      CLAIMS_MS_INTERNAL_ORIGIN: internal(listenOrigin), CLAIMS_MS_GRAPH_ORIGIN: internal(graph.origin),
    } }
  } catch (e) { await graph?.close(); await emulator.close(); throw e }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { 'write-env': { type:'string' }, 'app-origin': { type:'string' }, cms: { type:'boolean' }, showcase: { type:'boolean' },
    docker: { type:'boolean' }, podman: { type:'boolean' }, port: { type:'string', default:'0' } } })
  if (!values['write-env']) throw new Error('Supply --write-env with a new private file path')
  if (values.docker && values.podman) throw new Error('Select one container engine')
  const cms = values.cms ?? process.env.CLAIMS_CMS_MCP === '1'
  const origin = values['app-origin'] || (cms ? 'http://127.0.0.1:3180' : 'http://localhost:3080')
  const { emulator, env } = await startMailLab(origin, {
    docker: values.docker, containerHost: values.podman ? 'host.containers.internal' : undefined, port: Number(values.port), cms, showcase: values.showcase || cms,
  })
  try {
    await writeFile(values['write-env'], Object.entries(env).map(([key,value]) => key + "='" + value + "'").join('\n') + '\n',
      { flag: 'wx', mode: 0o600 })
    console.log('Synthetic Outlook is ready at ' + emulator.url + '. Keep this process running while using the demo.')
  } catch (e) { await emulator.close(); throw e }
  for (const sig of ['SIGINT','SIGTERM']) process.once(sig, () => { void emulator.close() })
}
