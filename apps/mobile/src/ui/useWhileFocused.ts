import { useIsFocused } from 'expo-router'
import { useDeferredValue, useRef } from 'react'

/**
 * The value as it was when this screen was last in front. A screen under another one (the session
 * list under an open thread) then keeps its work, instead of redoing it for every streamed update.
 * Coming back, the catch-up is low priority, so it never gets in the way of the screen sliding in.
 */
export function useWhileFocused<T>(value: T): T {
  const focused = useIsFocused()
  const held = useRef(value)
  if (focused) held.current = value
  return useDeferredValue(held.current)
}
