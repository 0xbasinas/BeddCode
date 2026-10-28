import { useState } from 'react'

/** A diff in the thread shows this many lines before a button for the rest. */
export const INLINE_PATCH_LINES = 120

/**
 * A unified-diff body: added lines green, removed red, hunk headers muted. With a `limit`, a longer
 * patch shows its first lines and a button for the rest: every line is a few elements, and a
 * thread with many large diffs would otherwise hold tens of thousands of them.
 */
export function PatchView({ patch, limit = Infinity }: { patch: string; limit?: number }) {
  const [all, setAll] = useState(false)
  const lines = patch.split('\n')
  const shown = all ? lines : lines.slice(0, limit)
  return (
    <>
      <pre className="patch">
        {shown.map((line, i) => {
          const metadata = /^(\+\+\+|---|@@|diff |index )/.test(line)
          const kind = metadata
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : ''
          const prefixed = !metadata && /^[ +-]/.test(line)
          return (
            <div key={i} className={kind}>
              <span className="patch-sign" aria-hidden="true">
                {kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}
              </span>
              <span className="patch-code">{(prefixed ? line.slice(1) : line) || ' '}</span>
            </div>
          )
        })}
      </pre>
      {shown.length < lines.length && (
        <button className="patch-more" onClick={() => setAll(true)}>
          Show {lines.length - shown.length} more lines
        </button>
      )}
    </>
  )
}
