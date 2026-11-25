// Exercise a new protected conversation in the real Workbench drawer.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pickEmployee } from '../../auth/tests/picker.mjs'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const app = new URL(process.env.CLAIMS_APP_ORIGIN || 'http://127.0.0.1:3180')
assert.ok(app.protocol === 'http:' && ['localhost','127.0.0.1'].includes(app.hostname))
const browser = await chromium.launch({ channel: process.env.CLAIMS_BROWSER_CHANNEL || 'chromium' })
try {
  const page = await browser.newPage({ viewport: { width:1440, height:900 } })
  page.setDefaultTimeout(25000)
  await page.goto(new URL('/open-workbench', app).href)
  await pickEmployee(page, 'maya')
  await page.getByRole('button', {name:'Ask agent',exact:true}).click()
  const drawer = page.getByRole('dialog', {name:'Claims chat panel'})
  const button = (parent, name) => parent.getByRole('button', {name,exact:true})
  const endpoint = p => new URL('/claims/api/' + p, page.url()).href
  const read = async p => {
    const result = await page.request.get(endpoint(p))
    assert.equal(result.status(), 200)
    return result.json()
  }
  await button(drawer, 'Conversations').waitFor()
  const {csrfToken} = await read('chat/bootstrap')
  const created = await page.request.post(endpoint('chat/conversations'), {headers:{origin:new URL(page.url()).origin,'x-csrf-token':csrfToken},
    data:{scope:{kind:'workspace'},fresh:true}})
  assert.equal(created.status(), 200)
  const {id} = await created.json()
  await button(drawer, 'Conversations').click()
  const picker = drawer.getByRole('region', {name:'Choose conversation scope'})
  await button(picker, 'Workspace').first().click()
  await drawer.locator('.cc-head').getByText('Workspace', {exact:true}).waitFor()
  console.log('Opened a fresh conversation in Maya’s Workbench drawer.')
  const text = drawer.getByRole('textbox', {name:'Message the claims agent'})
  async function submit(prompt) {
    await text.fill(prompt)
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === endpoint('chat/turn/' + id))
    await button(drawer, 'Send').click()
    const accepted = await response
    assert.equal(accepted.status(),200)
    return drawer.locator('article.cc-turn').filter({has:page.getByText(prompt,{exact:true})})
  }
  const unknown = await submit('Open WC-900001 or WC-900002.')
  await button(unknown, 'Cancel question').waitFor()
  assert.equal(await drawer.getByRole('dialog', {name:'Choose scope'}).count(), 0)
  await button(drawer, 'Collapse').click()
  await button(page, 'Ask agent').click()
  const detail = 'WC-900003 or WC-900004'
  await unknown.getByRole('textbox', {name:'Your answer'}).fill(detail)
  await button(unknown, 'Continue').click()
  await unknown.getByText(detail, {exact:true}).waitFor()
  await button(unknown, 'Cancel question').click()
  await unknown.getByText('Question cancelled.', {exact:true}).waitFor()
  console.log('The original turn retained the free-text correction after reopening and accepted cancellation.')
  const actions = await submit('Do I have any open action items?')
  await actions.getByText(/^[0-9]+ confirmed open action items?\.$/).waitFor()
  const before = (await read('mailbox')).items.filter(m => m.status === 'unread').map(m => m.id).sort()
  const inbox = await submit('Show my unread notifications from my inbox.')
  await inbox.getByText(new RegExp('^' + before.length + ' unread Workbench notifications?\\.$')).waitFor()
  const after = (await read('mailbox')).items.filter(m => m.status === 'unread').map(m => m.id).sort()
  assert.deepEqual(after, before)
  const conversation = await read('chat/conversation/' + id)
  assert.deepEqual(conversation.turns.map(t => t.state), ['cancelled','completed','completed'])
  assert.equal(conversation.turns[0].clarifications[0].answer.custom, detail)
  assert.deepEqual(conversation.turns.slice(1).map(t => t.plan.operation), ['actions','unread'])
  console.log('PASS Maya’s Workbench drawer preserves a pending clarification across collapse, cancels it, and returns verified action and unread counts without marking notifications read.')
} finally {
  await browser.close()
}
