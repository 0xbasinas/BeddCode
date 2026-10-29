import type { Readable } from 'node:stream'

/** The longest line kept from an agent's output by default: far beyond any real message. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024

export interface LineReaderOptions {
  /** Longer lines are dropped (and reported), so a runaway writer cannot exhaust memory. */
  maxBytes?: number
  onOversize?(bytes: number): void
  /** A line handler that throws must not lose the lines after it. */
  onError?(err: unknown): void
}

/**
 * Splits a byte stream into lines. Unlike `readline`, a line that grows past `maxBytes` without
 * ending is not buffered further: it is dropped up to its newline and reported once. Bytes are
 * decoded only per whole line, so a multi-byte character split across chunks stays intact, and
 * invalid UTF-8 turns into replacement characters rather than an error.
 */
export function readLines(
  input: Readable,
  onLine: (line: string) => void,
  options: LineReaderOptions = {},
): void {
  const max = options.maxBytes ?? MAX_LINE_BYTES
  let parts: Buffer[] = []
  let size = 0
  /** Bytes of an oversized line thrown away so far; set while skipping to its end. */
  let skipping: number | undefined

  const emit = (buf: Buffer) => {
    let end = buf.length
    if (end > 0 && buf[end - 1] === 0x0d) end-- // \r\n
    try {
      onLine(buf.toString('utf8', 0, end))
    } catch (err) {
      options.onError?.(err)
    }
  }
  const overflow = (bytes: number) => {
    skipping = (skipping ?? 0) + bytes
  }
  const finishSkip = (bytes: number) => {
    const total = (skipping ?? 0) + bytes
    skipping = undefined
    options.onOversize?.(total)
  }

  input.on('data', (chunk: Buffer | string) => {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    for (;;) {
      const nl = buf.indexOf(0x0a)
      if (nl < 0) {
        if (skipping !== undefined) overflow(buf.length)
        else if (size + buf.length > max) {
          overflow(size + buf.length)
          parts = []
          size = 0
        } else if (buf.length > 0) {
          parts.push(buf)
          size += buf.length
        }
        return
      }
      const head = buf.subarray(0, nl)
      buf = buf.subarray(nl + 1)
      if (skipping !== undefined) {
        finishSkip(head.length)
        continue
      }
      if (size + head.length > max) {
        const total = size + head.length
        parts = []
        size = 0
        finishSkip(total)
        continue
      }
      const line = parts.length === 0 ? head : Buffer.concat([...parts, head])
      parts = []
      size = 0
      emit(line)
    }
  })
  input.on('end', () => {
    if (skipping !== undefined) finishSkip(0)
    else if (size > 0) emit(Buffer.concat(parts))
    parts = []
    size = 0
  })
}
