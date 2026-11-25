import { inboxSource } from '../ui/outlook-chat.mjs'

/** Resolve Workbench reads without opening or acknowledging a work item. */
export function parseWorkQuery(question) {
  const source = inboxSource(question)
  if (source === 'workbench') return { kind: 'workbench', operation: /\bunread\b/i.test(question) ? 'unread' : 'inbox' }
  if (source || !/\b(?:action[ -]?items?|open tasks?|outstanding tasks?|tasks? (?:assigned to me|to do)|to[ -]?dos?)\b/i.test(question)) return null
  if (/\b(?:create|update|close|complete|delete|assign|write|export|mark|in (?:this|the) (?:file|repository))\b/i.test(question) || /["“`]/.test(question)) return null
  return { kind: 'workbench', operation: 'actions' }
}
