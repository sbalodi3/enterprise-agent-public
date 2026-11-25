// Run against the CMS-enabled local showcase. Uses a new chat and reads synthetic records.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pickEmployee } from '../../auth/tests/picker.mjs'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const origin = new URL(process.env.CLAIMS_APP_ORIGIN || 'http://127.0.0.1:3180')
assert.ok(['127.0.0.1','localhost'].includes(origin.hostname))
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chrome' })
const button = (root, name) => root.getByRole('button', { name, exact: true })
try {
  const page = await browser.newPage({ viewport: {width: 1440, height: 950} })
  page.setDefaultTimeout(35000)
  await page.route('**/desktop/presence', route => route.abort())
  await page.goto(new URL('/open-workbench',origin).href)
  await pickEmployee(page, 'claims-admin')
  await page.getByRole('searchbox', {name:'Claim number or keywords'}).waitFor()
  async function read(path) {
    const res = await page.request.get(new URL('/claims/api/chat/' + path, origin).href)
    assert.ok(res.ok(), path + ' returned ' + res.status())
    return res.json()
  }
  const cohort = await read('search?status=open&lob=AUTO&lob=COMM_AUTO&limit=1')
  assert.ok(cohort.total > 12)
  for (const [name,action] of [['Preview Notice','Continue'],['Add an API key to get started','Configure later']]) {
    const dialog = page.getByRole('dialog',{name})
    await page.addLocatorHandler(dialog, () => button(dialog,action).click())
  }
  await page.goto(new URL('/open-app',origin).href)
  const composer = page.locator('[data-composer-card]:visible')
  const picker = page.getByRole('dialog', {name:'Choose scope'})
  await button(composer,'Choose scope').waitFor({timeout:120000})
  await button(page,'New session').last().click()
  const editor = composer.locator('[contenteditable=true]').first()
  async function submit(text) {
    const receipt = page.waitForResponse(r => /\/claims\/api\/chat\/turn\//.test(r.url()) && r.request().method() === 'POST')
    await editor.fill(text)
    await editor.press('Enter')
    const res = await receipt
    assert.ok(res.ok(), text + ' admission returned ' + res.status())
    return res.json()
  }
  async function settled(receipt, expected, previousQuestion) {
    const deadline = Date.now() + 200000
    let turn, record
    do {
      record = await read('conversation/' + receipt.conversationId)
      turn = record.turns.find(t => t.id === receipt.turnId)
      if (turn && turn.state !== 'running' && (!previousQuestion || turn.pendingQuestion?.id !== previousQuestion)) break
      await new Promise(resolve => setTimeout(resolve, 720))
    } while (Date.now() < deadline)
    assert.equal(turn?.state, expected, (turn?.error || turn?.pendingQuestion?.question || '') + ' ' + turn?.question)
    const article = page.locator('.cs-transcript:visible article[data-turn-state=' + expected + ']')
      .filter({has:page.getByText(turn.question,{exact:true})}).last()
    await article.waitFor()
    return {record,turn,article}
  }
  const list = await settled(await submit('Can you produce me a list of all open auto claims'), 'completed')
  assert.equal(await picker.count(),0)
  assert.equal(list.turn.answer.cases.total,cohort.total)
  assert.deepEqual(list.turn.plan.filters.lobs,['AUTO','COMM_AUTO'])
  await button(list.article,'Next cases').click()
  await list.article.getByText('13–24 of ' + cohort.total, {exact:true}).waitFor()
  const count = await settled(await submit('How many of those?'),'completed')
  assert.equal(count.turn.plan.operation,'count')
  assert.match(count.turn.answer.text,new RegExp('\\b' + cohort.total + '\\b'))
  console.log('PASS open auto claims, verified count and pagination:',cohort.total)

  await button(composer,'Choose scope').click()
  await picker.getByRole('searchbox',{name:'Find a claim'}).fill('CLM-000020')
  await picker.getByRole('checkbox',{name:'Select CLM-000020'}).check()
  await button(picker,'Apply scope').click()
  await button(composer,'Remove CLM-000020').waitFor()
  const receipt = await submit('Review the claim for Kimberly Ramirez')
  const first = await settled(receipt,'awaiting_input')
  assert.equal(first.turn.pendingQuestion.kind,'candidate')
  await page.reload()
  await button(first.article,'No').click()
  const second = await settled(receipt,'awaiting_input',first.turn.pendingQuestion.id)
  assert.notEqual(second.turn.pendingQuestion.question,first.turn.pendingQuestion.question)
  await button(second.article,'Other').click()
  await second.article.getByLabel('Your answer').fill('CLM-000017')
  await button(second.article,'Continue').click()
  const answer = await settled(receipt,'completed',second.turn.pendingQuestion.id)
  assert.deepEqual(answer.record.scope.claimIds,['CLM-000020'])
  assert.deepEqual(answer.record.focus.claimIds,['CLM-000017'])
  await answer.article.getByText('CLM-000017',{exact:true}).waitFor()
  await composer.getByText('Current · CLM-000017').waitFor()
  const inbox = await settled(await submit('Show me my unread notificaiton from my inbox'),'completed')
  assert.equal(inbox.turn.plan.operation,'unread')
  assert.deepEqual(inbox.record.focus.claimIds,['CLM-000017'])
  console.log('PASS manual pin, corrected candidate, refresh, original-turn continuation and Workbench unread')
  const followup = await settled(await submit('What is its next step?'),'completed')
  assert.deepEqual(followup.turn.scope.claimIds,['CLM-000017'])
  const confirm = await submit('Summarize the claim for Kimberly Ramirez')
  const match = await settled(confirm,'awaiting_input')
  const target = match.turn.pendingQuestion.question.match(/CLM-\d{6}/)[0]
  await button(match.article,'Yes').click()
  const confirmed = await settled(confirm,'completed',match.turn.pendingQuestion.id)
  assert.deepEqual(confirmed.record.focus.claimIds,[target])
  assert.deepEqual(confirmed.record.scope.claimIds,['CLM-000020'])
  assert.deepEqual(confirmed.turn.clarifications.at(-1).answer.selected,['yes'])
  console.log('PASS follow-up uses the current claim and Yes answers the original question')
} finally {
  await browser.close()
}
