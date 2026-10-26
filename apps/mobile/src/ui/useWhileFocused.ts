import { useIsFocused } from 'expo-router'
import { useRef } from 'react'

/**
 * The value as it was when this screen was last in front. A screen under another one (the session
 * list under an open thread) then keeps its work, instead of redoing it for every streamed update.
 */
export function useWhileFocused<T>(value: T): T {
  const focused = useIsFocused()
  const held = useRef(value)
  if (focused) held.current = value
  return held.current
}
