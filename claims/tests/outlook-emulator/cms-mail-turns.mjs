import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDomain, seed } from '../../domain/index.mjs'
import { createClaimReads, startClaimMcp } from '../../runtime/chat-mcp.mjs'
import { createMailChat } from '../../connections/mail-chat.mjs'
import { createOutlookChat } from '../../ui/outlook-chat.mjs'

const employees = [
  { id: 'cms-adjuster-01', claim: 'CLM-000020', receipt: 'AK-020-REVIEW' },
  { id: 'cms-adjuster-02', claim: 'CLM-000017', receipt: 'BL-017-REVIEW' },
]

/** Exercise the native composer's source decision and protected turns after the two
 * resolved employee identities complete their own emulator consent flows. */
export async function verifyCmsMailTurns(t, { pool, connections, mailboxes, cmsSnapshot }) {
  const session = 'cms-mail-' + randomUUID()
  const originalFetch = globalThis.fetch
  let graphCalls = 0
  const mailChat = createMailChat({
    pool, connections,
    graphConfig: { fetch: (...args) => { graphCalls++; return originalFetch(...args) } },
    async runAgent({ reads }) {
      // Model fixture deliberately omits the search term. The employee's literal
      // claim identifier must survive all the way to the emulator's Graph query.
      if (reads.selected) await reads.call('read_outlook_message', { ref: reads.selected })
      else await reads.call('search_outlook', {})
    },
  })
  const handles = new Map()
  let principal, mailRequests = 0
  const getPrincipal = id => {
    const employee = mailboxes.find(mailbox => mailbox.principal.principalId === id)?.principal
    assert.ok(employee?.subject, 'expected a resolved employee identity for ' + id)
    return employee
  }
  const invoke = (method, input = {}) => mailChat({
    principal, method, path: session, input, reauthorize: () => {}, signal: AbortSignal.timeout(10000),
  })
  const post = (question, extras) => invoke('POST', {
    selected: false, timeZone: 'America/New_York', requestId: randomUUID(), question, ...extras,
  })
  // Replace only the relative browser-to-Workbench fetch. All provider requests
  // continue through the encrypted grant, token, and emulator HTTP transport.
  const browserFetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== '/claims/api/mail-chat/' + session) return originalFetch(url, init)
    mailRequests++
    const turn = await invoke(init.method, init.body ? JSON.parse(init.body) : {})
    return Response.json(turn)
  })
  try {
    for (const employee of employees) {
      principal = getPrincipal(employee.id)
      const other = employees.find(person => person.id !== employee.id)
      const composer = createOutlookChat({}, 'test-csrf')
      const ask = question => composer.dispatch(session, question, 0)
      const claimQuestion = 'What is the status of claim ' + employee.claim + '?'
      const before = [mailRequests, graphCalls]
      assert.equal(await ask(claimQuestion), null)
      assert.deepEqual([mailRequests, graphCalls], before)
      // A direct client also cannot make claim-only text reach a mailbox tool.
      await assert.rejects(post(claimQuestion), { code: 'mail_read_only' })
      assert.equal(graphCalls, before[1])

      assert.equal(await ask('Find my Outlook emails about ' + employee.claim), 'handled')
      const search = composer.state(session).mailTurns.at(-1).answer
      assert.equal(search.kind, 'search')
      assert.deepEqual(search.items.map(item => item.subject).sort(), [
        employee.claim + ' correspondence', employee.claim + ' review update',
      ])
      const item = search.items.find(row => row.subject.endsWith(' correspondence'))
      handles.set(employee.id, item.ref)

      const afterSearch = [mailRequests, graphCalls]
      assert.equal(await ask(claimQuestion), null)
      assert.equal(await ask('Open the first one'), null)
      assert.deepEqual([mailRequests, graphCalls], afterSearch)
      const own = await post('Open this Outlook email.', { readRef: item.ref })
      assert.equal(own.turn.answer.kind, 'read')
      assert.ok(own.turn.answer.text.includes(employee.receipt))
      assert.ok(!own.turn.answer.text.includes(other.receipt))

      assert.equal(await ask('Search my inbox for ' + other.claim), 'handled')
      assert.deepEqual(composer.state(session).mailTurns.at(-1).answer.items, [])
    }
    for (const employee of employees) {
      principal = getPrincipal(employee.id)
      const other = employees.find(person => person.id !== employee.id)
      const before = graphCalls
      await assert.rejects(post('Open this Outlook email.', { readRef: handles.get(other.id) }), { code: 'mail_reference_missing' })
      assert.equal(graphCalls, before)
      const { turns } = await invoke('GET')
      assert.equal(turns.filter(turn => turn.answer.kind === 'read').length, 1)
      assert.ok(!JSON.stringify(turns.map(turn => turn.answer)).includes(other.receipt))
    }
    await t.test('all linked Outlook adjusters can read only their assigned CMS claim briefs through MCP', async () => {
      await seed(pool, { showcase: true, cmsSnapshot })
      const domain = createDomain(pool, { showcase: {} })
      const before = [mailRequests, graphCalls]
      for (const [index, mailbox] of mailboxes.entries()) {
        principal = mailbox.principal
        const ownClaim = mailbox.claims[0]
        const foreignClaim = mailboxes[(index + 1) % mailboxes.length].claims[0]
        const composer = createOutlookChat({}, 'test-csrf')
        for (const id of [ownClaim, foreignClaim]) {
          assert.equal(await composer.dispatch(session, 'Show me claim ' + id, 0), null)
          const brief = await claimBrief(domain, principal, id)
          if (id === ownClaim) {
            assert.equal(brief.structuredContent.claimId, id)
            assert.equal(brief.structuredContent.ownerId, principal.principalId)
          } else {
            assert.equal(brief.isError, true)
            assert.equal(brief.content[0].text, 'not_found')
            assert.equal(brief.structuredContent, undefined)
          }
        }
      }
      assert.deepEqual([mailRequests, graphCalls], before)
    })
  } finally { browserFetch.mock.restore() }
}

async function claimBrief(domain, principal, id) {
  const scope = { kind: 'claim', claimIds: [id] }
  const signal = AbortSignal.timeout(10000)
  const reads = createClaimReads({ domain, principal, scope, signal, allowed: ['get_claim_brief'],
    reauthorize: dependencies => domain.assertChatScope(principal, scope, dependencies),
  })
  const mcp = await startClaimMcp(reads, signal)
  try {
    const response = await fetch(mcp.url, { method: 'POST', signal,
      headers: { authorization: mcp.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_claim_brief', arguments: {} } }),
    })
    assert.equal(response.status, 200)
    return (await response.json()).result
  } finally { await mcp.close() }
}
