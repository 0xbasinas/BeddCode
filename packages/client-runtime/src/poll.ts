/** Serial polling. Refreshes during a request become one follow-up, never parallel requests. */
export function createPoller<T>(options: {
  load(): Promise<T>
  value(value: T): void
  error(error: unknown): void
  intervalMs: number
  visible?(): boolean
}) {
  let stopped = false
  let busy = false
  let requested = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (stopped || options.intervalMs <= 0) return
    timer = setTimeout(() => {
      if (options.visible?.() === false) schedule()
      else refresh()
    }, options.intervalMs)
  }
  const refresh = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    if (busy) {
      requested = true
      return
    }
    busy = true
    void Promise.resolve()
      .then(options.load)
      .then(
        (value) => {
          if (!stopped) options.value(value)
        },
        (error: unknown) => {
          if (!stopped) options.error(error)
        },
      )
      .finally(() => {
        busy = false
        if (stopped) return
        if (requested) {
          requested = false
          refresh()
        } else schedule()
      })
  }
  return {
    refresh,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
