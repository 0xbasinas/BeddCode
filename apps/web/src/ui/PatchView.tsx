/** A unified-diff body: added lines green, removed red, hunk headers muted. */
export function PatchView({ patch }: { patch: string }) {
  return (
    <pre className="patch">
      {patch.split('\n').map((line, i) => {
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
  )
}
