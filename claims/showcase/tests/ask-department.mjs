import assert from 'node:assert/strict'

// The open Workbench record sets the scope for either supported deployment mode.
export async function askDepartment(page, department, record, question) {
  const shared = (await page.locator('meta[name="claims-shared-host"]').count()) > 0
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  let input
  if (shared) {
    for (const [title, action] of [['Preview Notice', 'Continue'], ['Add an API key to get started', 'Configure later']]) {
      const dialog = page.getByRole('dialog', {name:title})
      await page.addLocatorHandler(dialog, () => dialog.getByRole('button', {name:action, exact:true}).click())
    }
    await page.waitForURL((url) => url.pathname === '/chat' && url.searchParams.has('session'))
    input = page.locator('[data-composer-input][contenteditable=true]:visible').first()
    assert.equal(await page.getByLabel('Department record').inputValue(), record)
  } else {
    input = page.getByRole('textbox', { name: 'Question for the ' + department + ' agent' })
  }
  const ready = page.waitForResponse(
    (response) => {
      const path = new URL(response.url()).pathname
      return (
        response.request().method() === 'POST' &&
        path.includes('/departments/' + department + '/') &&
        path.endsWith('/ask')
      )
    },
    { timeout: 150000 },
  )
  await input.fill(question)
  if (shared) await input.press('Enter')
  else await page.getByRole('button', { name: 'Send', exact: true }).click()
  const response = await ready
  assert.equal(response.status(), 200, await response.text())
  const historyUrl = shared ? response.url().slice(0, -4) : response.url()
  const saved = await (await page.request.get(historyUrl)).json()
  const turn = (shared ? saved.turns : saved.items).findLast((turn) => turn.question === question)
  assert.ok(turn)
  return { answer: turn.answer, shared }
}
