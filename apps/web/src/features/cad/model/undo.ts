import type { CadDocument } from './CadDocument.ts'

const LIMIT = 100

function clone(doc: CadDocument): CadDocument {
  return structuredClone(doc)
}

/**
 * Undo and redo for whole-document snapshots. `push` drops the redo tail.
 * The document's own `historyIndex` is stored inside each snapshot.
 */
export class UndoStack {
  private past: CadDocument[] = []
  private future: CadDocument[] = []
  private present: CadDocument

  constructor(initial: CadDocument) {
    this.present = clone(initial)
  }

  current(): CadDocument {
    return this.present
  }

  canUndo(): boolean {
    return this.past.length > 0
  }

  canRedo(): boolean {
    return this.future.length > 0
  }

  push(next: CadDocument): void {
    this.past.push(this.present)
    if (this.past.length > LIMIT) this.past.shift()
    this.present = clone(next)
    this.future = []
  }

  undo(): CadDocument {
    const previous = this.past.pop()
    if (!previous) return this.present
    this.future.push(this.present)
    this.present = previous
    return this.present
  }

  redo(): CadDocument {
    const next = this.future.pop()
    if (!next) return this.present
    this.past.push(this.present)
    this.present = next
    return this.present
  }
}
