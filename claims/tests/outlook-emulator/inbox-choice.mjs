import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createChatHost } from '../chat-host-fixture.mjs'
import { MailToolModel } from '../outlook-model-fixture.mjs'
import { seed } from '../../domain/index.mjs'
import { apply as installWorkbench } from '../../runtime/plugin.mjs'

// Run the mounted Workbench routes, including the production handoff between the
// claims and mail runtimes. The mailbox, employee session and model are local fixtures.
export async function verifyInboxChoice(t, { lab, pool, owners, request, consent, auth, mount }) {
  const [maya, alex] = owners
  await seed(pool)
  await consent(maya, lab.users[0].email)
  const host = await createChatHost(t, {id:'claims-v1'})
  const model = new MailToolModel({})
  host.llm.registerAdapter(['claims-local'], model)
  const effects = []
  const config = { ...lab.env, CLAIMS_SHOWCASE:'0', CLAIMS_TEMPORAL_ENABLED:'false', CLAIMS_WIDGETS_DISABLED:'1',
    CLAIMS_WAGE_REVIEW:'0', CLAIMS_FIXTURE_TOKEN:randomUUID(), CLAIMS_WORKER_TOKEN:randomUUID(), OTEL_EXPORTER_OTLP_ENDPOINT:'' }
  const before = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]))
  Object.assign(process.env, config)
  try {
    await installWorkbench({
      claimsDatabase:pool, claimsAuth:auth, agents:host.agents, agentPresets:host.agentPresets, llm:host.llm,
      effect(register) { const dispose = register(); if (typeof dispose === 'function') effects.push(dispose) },
      webServer:{ register({path, handler}) { if (path === '/claims/api') mount(handler) } },
    })
    async function call(employee, path, input, expected = 200) {
      const res = await request(employee, '/claims/api/' + path, input ? 'POST' : 'GET', input)
      const value = await res.json()
      assert.equal(res.status, expected, JSON.stringify(value))
      return value
    }
    const chat = await call(maya, 'chat/conversations', {scope:{kind:'workspace'},fresh:true})
    const question = 'Show me the unread messages in my inbox'
    const ask = () => call(maya, 'chat/turn/' + chat.id, {question, planned:true, expectedRevision:chat.scopeRevision,
      requestId:randomUUID(), timeZone:'America/New_York'})
    async function snapshot() {
      // The stream closes after an answer or question is committed.
      const events = await request(maya, '/claims/api/chat/events/' + chat.id)
      assert.equal(events.status,200)
      await events.text()
      return call(maya, 'chat/conversation/' + chat.id)
    }
    async function choose(turnId, source) {
      const current = (await snapshot()).turns.find(turn => turn.id === turnId)
      assert.equal(current.state,'awaiting_input')
      assert.deepEqual(current.pendingQuestion.options.map(o => o.id),['workbench','outlook'])
      const reply = await call(maya, 'chat/reply/' + chat.id, {turnId, questionId:current.pendingQuestion.id,
        expectedRevision:chat.scopeRevision, requestId:randomUUID(), answer:{selected:[source]}})
      assert.equal(reply.turnId,turnId)
      return (await snapshot()).turns.find(turn => turn.id === turnId)
    }
    const mailbox = 'mail-chat/claims-' + chat.id
    const outlook = await ask()
    assert.deepEqual((await call(maya, mailbox)).turns, [])
    const mail = await choose(outlook.turnId, 'outlook')
    assert.equal(mail.state, 'completed')
    assert.deepEqual(mail.answer, {text:'Outlook Mail',outlookRef:outlook.turnId,sources:[]})
    const exact = mailbox + '?turn=' + mail.answer.outlookRef
    const result = (await call(maya, exact)).turn
    assert.equal(result.id, outlook.turnId)
    assert.equal(result.question, question)
    const update = result.answer.items.find(m => m.subject === 'Operations update')
    assert.ok(update)
    assert.match(update.excerpt,/Westfield operations/)
    assert.ok(!result.answer.items.some(m => ['Westfield invoice','Unsent draft'].includes(m.subject)))

    const opened = (await call(maya, mailbox, {requestId:randomUUID(),selected:true,question:'Open this Outlook email.',
      readRef:update.ref,timeZone:'America/New_York'})).turn
    assert.match(opened.answer.text,/Westfield operations have a new invoice schedule/)
    assert.notEqual(opened.id,result.id)
    assert.deepEqual((await call(maya,exact)).turn, result)
    assert.equal((await call(alex,exact,undefined,404)).code,'not_found')
    assert.equal((await call(maya,'mail-chat/claims-' + randomUUID() + '?turn=' + outlook.turnId,undefined,404)).code,'not_found')

    const callsBeforeWorkbench = model.seen.length
    const work = await choose((await ask()).turnId, 'workbench')
    assert.equal(work.state,'completed')
    assert.equal(work.answer.work.operation,'unread')
    assert.ok(work.answer.work.sections[0].items.some(item => item.id === 'assigned-WC-101'))
    assert.equal(work.answer.outlookRef,undefined)
    assert.equal(model.seen.length,callsBeforeWorkbench)
    assert.equal((await call(maya,mailbox)).turns.length,2)
    const claims = await snapshot()
    assert.deepEqual(claims.turns.map(turn=>turn.id),[outlook.turnId,work.id])
    for (const secret of [update.subject, update.excerpt, opened.answer.text, update.ref]) {
      assert.ok(!JSON.stringify(claims).includes(secret), 'mail content or handle leaked into claims history')
    }
  } finally {
    for (const dispose of effects.reverse()) await dispose()
    for (const [key, previous] of Object.entries(before)) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  }
}
