import { createElement, useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A profile can run protected turns alongside a workspace without copying them into its log. */
export interface ConversationCompanion {
  observe?(sessionId: SessionId, notify: () => void): () => void
  hasTurns?(sessionId: SessionId): boolean
  history?: ComponentType<{ sessionId: SessionId }>
  transcript: ComponentType<{ sessionId: SessionId }>
  controls: ComponentType<{ sessionId: SessionId }>
  chips: ComponentType<{ sessionId: SessionId }>
  /** Keep the outgoing session read-only while a navigation is resolving its target. */
  preparingSession?(sessionId: SessionId): boolean
  hasThread(sessionId: SessionId): boolean
  isScoped(sessionId: SessionId): boolean
  dispatch(sessionId: SessionId, text: string, attachments: number, signal?: AbortSignal): Promise<'workspace' | 'handled' | 'hold'>
}

let current: ConversationCompanion | undefined
const listeners = new Set<() => void>()
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } }
export const companion = () => current
export function installCompanion(value: ConversationCompanion): () => void {
  current = value
  for (const notify of listeners) notify()
  return () => {
    if (current !== value) return
    current = undefined
    for (const notify of listeners) notify()
  }
}

export function useCompanionPreparingSession(sessionId: SessionId | undefined): boolean {
  const service = useSyncExternalStore(subscribe, companion, companion)
  return sessionId !== undefined && service?.preparingSession?.(sessionId) === true
}

/** Keep the native shell mounted while an installed profile supplies its own protected content. */
export function CompanionSeat({ sessionId, seat }: { sessionId: SessionId | undefined; seat: 'history' | 'transcript' | 'chips' | 'controls' }) {
  const service = useSyncExternalStore(subscribe, companion, companion)
  const View = service?.[seat]
  return View && sessionId ? createElement(View, { sessionId }) : null
}

/** The native empty hero yields to the protected transcript after its first turn. */
export function useCompanionState(sessionId: SessionId | undefined): number {
  const service = useSyncExternalStore(subscribe, companion, companion)
  return useSyncExternalStore(
    notify => sessionId && service?.observe ? service.observe(sessionId, notify) : () => {},
    () => sessionId && service ? (service.isScoped(sessionId) ? 1 : 0) + (service.hasTurns?.(sessionId) ? 2 : 0) : 0,
    () => 0,
  )
}
