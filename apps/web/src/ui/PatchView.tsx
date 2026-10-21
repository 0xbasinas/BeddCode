/** A unified-diff body: added lines green, removed red, hunk headers muted. */
export function PatchView({ patch }: { patch: string }) {
  return (
    <pre className="patch">
      {patch.split('\n').map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : line.startsWith('@@')
                  ? 'hunk'
                  : ''
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}
