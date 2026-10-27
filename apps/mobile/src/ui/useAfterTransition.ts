import { useNavigation } from 'expo-router'
import { useEffect, useState } from 'react'

// Long enough for the slide to finish; it only matters if the navigator never says it has.
const FALLBACK_MS = 450

// Both stacks send this event, but the router's general navigation type does not list it.
type Transitions = { addListener(event: 'transitionEnd', listener: () => void): () => void }

/**
 * False while the screen is still sliding in, true once it has settled. A screen that draws its
 * heavy parts only then starts sliding at once, instead of freezing while it builds them.
 */
export function useAfterTransition(): boolean {
  const navigation = useNavigation()
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const settle = () => setSettled(true)
    const stop = (navigation as unknown as Transitions).addListener('transitionEnd', settle)
    const timer = setTimeout(settle, FALLBACK_MS)
    return () => {
      stop()
      clearTimeout(timer)
    }
  }, [navigation])
  return settled
}
