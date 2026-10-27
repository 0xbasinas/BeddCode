import { useCallback, useEffect, useRef, useState } from 'react'
import { createPoller } from '@beddcode/client-runtime'

export interface Polled<T> {
  data: T | undefined
  error: string | undefined
  /** True only for the first load; later refreshes keep showing the previous data. */
  loading: boolean
  refresh(): void
}

/**
 * Loads data now, whenever `refreshKey` changes, and on an interval while the page is visible.
 * Requests never overlap within a poller, and responses from a previous key are ignored.
 */
export function usePolled<T>(
  load: () => Promise<T>,
  refreshKey: unknown,
  intervalMs = 4000,
): Polled<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const loadRef = useRef(load)
  loadRef.current = load
  const poller = useRef<ReturnType<typeof createPoller<T>> | null>(null)
  const run = useCallback(() => poller.current?.refresh(), [])

  useEffect(() => {
    const current = createPoller({
      load: () => loadRef.current(),
      value: (value) => {
        setData(value)
        setError(undefined)
        setLoading(false)
      },
      error: (error) => {
        setError(error instanceof Error ? error.message : String(error))
        setLoading(false)
      },
      intervalMs,
      visible: () => document.visibilityState === 'visible',
    })
    poller.current = current
    current.refresh()
    return () => {
      current.stop()
      if (poller.current === current) poller.current = null
    }
  }, [refreshKey, intervalMs])

  return { data, error, loading, refresh: run }
}
