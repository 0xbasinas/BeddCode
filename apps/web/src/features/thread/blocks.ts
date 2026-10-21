import type { TranscriptItem } from '@beddcode/client-runtime'

export interface EditedFile {
  path: string
  added: number
  removed: number
  patch: string
}

export type Block =
  { kind: 'item'; item: TranscriptItem } | { kind: 'edits'; id: string; files: EditedFile[] }

const sameFile = (a: string, b: string) => a.replace(/\\/g, '/') === b.replace(/\\/g, '/')

/**
 * Prepares a transcript for display. Each turn's file diffs are collected into one "Edited N
 * files" block, placed where that turn's last diff arrived; a file edited twice counts once with
 * its changes added together.
 */
export function buildBlocks(items: TranscriptItem[]): Block[] {
  // Index of the last diff in each turn; a user message starts a new turn.
  const lastDiffOfTurn = new Map<number, number>()
  let turn = 0
  const turnOf: number[] = []
  items.forEach((item, i) => {
    if (item.kind === 'message' && item.role === 'user') turn++
    turnOf.push(turn)
    if (item.kind === 'diff') lastDiffOfTurn.set(turn, i)
  })

  const filesByTurn = new Map<number, EditedFile[]>()
  items.forEach((item, i) => {
    if (item.kind !== 'diff') return
    const files = filesByTurn.get(turnOf[i]!) ?? []
    const existing = files.find((f) => sameFile(f.path, item.path))
    if (existing) {
      existing.added += item.added
      existing.removed += item.removed
      existing.patch = `${existing.patch}\n${item.patch}`
    } else {
      files.push({ path: item.path, added: item.added, removed: item.removed, patch: item.patch })
    }
    filesByTurn.set(turnOf[i]!, files)
  })

  const blocks: Block[] = []
  items.forEach((item, i) => {
    if (item.kind !== 'diff') return void blocks.push({ kind: 'item', item })
    const t = turnOf[i]!
    if (lastDiffOfTurn.get(t) === i) {
      // Copy, so later renders never see a list that grew after this block was built.
      blocks.push({ kind: 'edits', id: `edits-${t}`, files: [...filesByTurn.get(t)!] })
    }
  })
  return blocks
}

export const totalChanges = (files: EditedFile[]) => ({
  added: files.reduce((n, f) => n + f.added, 0),
  removed: files.reduce((n, f) => n + f.removed, 0),
})
