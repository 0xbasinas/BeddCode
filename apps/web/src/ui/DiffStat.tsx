/**
 * Added / removed line counts, the same everywhere (sidebar, thread, git, pull requests).
 * Keeps the `.stat` / `.add` / `.del` classes so the stylesheet owns size and color.
 */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="stat">
      <span className="add">+{added}</span> <span className="del">−{removed}</span>
    </span>
  )
}
