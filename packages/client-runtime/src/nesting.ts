/** A session that another session started sits under it, indented by how deep it is. */
export interface Nested<T> {
  session: T
  depth: number
}

/**
 * Orders a list so each session started by another follows its parent (and its parent's earlier
 * children), keeping the list's own order otherwise. A child whose parent is not in the list
 * stays where it is, at the top level.
 */
export function nestSessions<T extends { id: string; parent?: { sessionId: string } }>(
  list: readonly T[],
): Nested<T>[] {
  const ids = new Set(list.map((s) => s.id))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const s of list) {
    const parent = s.parent?.sessionId
    if (parent && parent !== s.id && ids.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), s])
    } else roots.push(s)
  }
  const out: Nested<T>[] = []
  const seen = new Set<string>()
  const visit = (s: T, depth: number) => {
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push({ session: s, depth })
    for (const child of children.get(s.id) ?? []) visit(child, depth + 1)
  }
  for (const s of roots) visit(s, 0)
  // A cycle cannot come from the host, but nothing should vanish if one did.
  for (const s of list) visit(s, 0)
  return out
}
