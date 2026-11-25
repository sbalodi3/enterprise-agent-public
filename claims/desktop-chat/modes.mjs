import { CMS_USERS, DEMO_USERS } from '../auth/roster.mjs'

// Keep existing bookmarks and reserve a separate contiguous range for the CMS showcase.
export function managedChatPorts(first, cms) {
  const highest = first + (cms ? 18 + CMS_USERS.length - 1 : DEMO_USERS.length - 1)
  if (!Number.isInteger(first) || first < 1024 || highest > 65535) throw new Error('Invalid managed chat port')
  const ports = DEMO_USERS.map(({ principalId }, index) => [principalId, first + index])
  if (cms) for (const [index, user] of CMS_USERS.entries()) ports.push([user.principalId, first + 18 + index])
  return Object.freeze(Object.fromEntries(ports))
}
export const MANAGED_CHAT_PORTS = managedChatPorts(Number(process.env.CLAIMS_CHAT_PORT_BASE || 3083),
  process.env.CLAIMS_SHOWCASE === '1' && process.env.CLAIMS_CMS_MCP === '1')
