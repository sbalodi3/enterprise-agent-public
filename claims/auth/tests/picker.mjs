/** Select an account through the emulator's real interactive OIDC form. */
export function pickEmployee(page, principalId) {
  return page.getByRole('list', { name: 'Pick an account' }).getByRole('button')
    .filter({ hasText: principalId + '@example.test' }).click()
}
