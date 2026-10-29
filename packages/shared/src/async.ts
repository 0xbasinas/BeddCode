export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`)
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** Single-consumer async queue: producers `push`, one consumer iterates until `close`. */
export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(item: T): void
  close(): void
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = []
  let waiting: ((r: IteratorResult<T>) => void) | null = null
  let closed = false

  return {
    push(item) {
      if (closed) return
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: item, done: false })
      } else items.push(item)
    },
    close() {
      closed = true
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: undefined, done: true })
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length > 0) return Promise.resolve({ value: items.shift() as T, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise<IteratorResult<T>>((resolve) => {
            waiting = resolve
          })
        },
      }
    },
  }
}

/** Rejects when `promise` has not settled within `ms`; the work itself is not cancelled. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
