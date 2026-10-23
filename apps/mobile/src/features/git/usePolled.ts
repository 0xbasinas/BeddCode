import { useCallback, useEffect, useRef, useState } from 'react'

export interface Polled<T> {
  data: T | undefined
  error: string | undefined
  /** True only for the first load; later refreshes keep showing the previous data. */
  loading: boolean
  refresh(): void
}

/**
 * Loads data now, whenever `refreshKey` changes, and on an interval while `active`. Out-of-order
 * responses are dropped, so a slow old request never overwrites a newer one.
 */
export function usePolled<T>(
  load: () => Promise<T>,
  refreshKey: unknown,
  active: boolean,
  intervalMs = 4000,
): Polled<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const latest = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const run = useCallback(() => {
    const id = ++latest.current
    loadRef.current().then(
      (value) => {
        if (id !== latest.current) return
        setData(value)
        setError(undefined)
        setLoading(false)
      },
      (err: unknown) => {
        if (id !== latest.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      },
    )
  }, [])

  useEffect(() => {
    if (active) run()
  }, [run, refreshKey, active])

  useEffect(() => {
    if (!active || intervalMs <= 0) return
    const timer = setInterval(run, intervalMs)
    return () => clearInterval(timer)
  }, [run, active, intervalMs])

  return { data, error, loading, refresh: run }
}
