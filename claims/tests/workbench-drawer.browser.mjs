// Run against the seeded local Workbench with node --env-file=claims/deploy/.env.
import { pickEmployee } from '../auth/tests/picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://localhost:3080/open-workbench')
  await pickEmployee(page, 'maya')
  const ask = page.getByRole('button', { name: 'Ask agent', exact: true })
  const panel = page.getByRole('dialog', { name: 'Claims chat panel' })
  const collapse = panel.getByRole('button', { name: 'Collapse' })
  await ask.click()
  await panel.getByText('My portfolio', { exact: true }).waitFor()
  await collapse.click()
  assert.equal(await page.getByRole('button', { name: 'Agent Chat', exact: true }).count(), 0)
  await page.getByRole('button', { name: /^Open WC-101\b/ }).click()
  await ask.click()
  await panel.getByText(/^(?:Pinned · )?Claim · WC-101$/).waitFor()
  await panel.getByRole('textbox', { name: 'Message the claims agent' }).fill('Synthetic unsent question')
  await page.setViewportSize({ width: 536, height: 587 })
  await page.waitForSelector('dialog.cc-drawer-dialog:modal')
  await collapse.click()
  await ask.click()
  assert.equal(await panel.getByRole('textbox').inputValue(), 'Synthetic unsent question')
  await collapse.click()
  assert.equal(await ask.getAttribute('aria-expanded'), 'false')
  console.log('PASS Workbench drawer opens in portfolio and claim scope, collapses, and retains its draft')
} finally {
  await browser.close()
}
