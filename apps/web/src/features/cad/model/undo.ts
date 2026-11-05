import type { CadDocument } from './CadDocument.ts'

/**
 * Snapshot undo stack for a CAD document. `index` matches `document.historyIndex`
 * on the document returned by `current`. A new commit drops the redo branch.
 */
export interface CadHistory {
  snapshots: CadDocument[]
  index: number
}

export function createHistory(doc: CadDocument): CadHistory {
  const initial = cloneDoc(doc)
  initial.historyIndex = 0
  return { snapshots: [initial], index: 0 }
}

export function current(history: CadHistory): CadDocument {
  const snapshot = history.snapshots[history.index]
  if (!snapshot) throw new Error('Undo history is empty')
  const doc = cloneDoc(snapshot)
  doc.historyIndex = history.index
  return doc
}

export function canUndo(history: CadHistory): boolean {
  return history.index > 0
}

export function canRedo(history: CadHistory): boolean {
  return history.index < history.snapshots.length - 1
}

/** Records `doc` as the new present and clears redo. */
export function commit(history: CadHistory, doc: CadDocument): CadHistory {
  const snapshots = history.snapshots.slice(0, history.index + 1).map(cloneDoc)
  const next = cloneDoc(doc)
  next.historyIndex = snapshots.length
  snapshots.push(next)
  return { snapshots, index: next.historyIndex }
}

/**
 * Applies `edit` to the current document and records the result.
 * Feature-tree edits go through here so undo restores the previous tree.
 */
export function update(history: CadHistory, edit: (doc: CadDocument) => CadDocument): CadHistory {
  return commit(history, edit(current(history)))
}

export function undo(history: CadHistory): CadHistory {
  if (!canUndo(history)) return history
  return { snapshots: history.snapshots, index: history.index - 1 }
}

export function redo(history: CadHistory): CadHistory {
  if (!canRedo(history)) return history
  return { snapshots: history.snapshots, index: history.index + 1 }
}

function cloneDoc(doc: CadDocument): CadDocument {
  return structuredClone(doc)
}
