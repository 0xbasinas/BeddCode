export interface TextDiff {
  patch: string
  added: number
  removed: number
}

const CONTEXT = 2
const MAX_LINES = 400

/**
 * A compact line diff for display: drops the common head and tail, then shows the changed middle
 * as removed/added lines with a little context. Not a minimal diff, but cheap and readable.
 */
export function diffText(oldText: string | null | undefined, newText: string): TextDiff {
  const a = oldText ? oldText.split('\n') : []
  const b = newText.split('\n')
  if (a.length > 0 && a.at(-1) === '') a.pop()
  if (b.length > 0 && b.at(-1) === '') b.pop()

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const removed = a.slice(head, a.length - tail)
  const added = b.slice(head, b.length - tail)
  const before = a.slice(Math.max(0, head - CONTEXT), head)
  const after = a.slice(a.length - tail, a.length - tail + CONTEXT)

  const lines = [
    ...before.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...after.map((l) => ` ${l}`),
  ]
  return {
    patch: lines.slice(0, MAX_LINES).join('\n'),
    added: added.length,
    removed: removed.length,
  }
}
