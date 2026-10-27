import { composerDraftKey } from '../composer/drafts.ts'

export const threadKey = composerDraftKey

interface ReadingPosition {
  top: number
  following: boolean
  /** Earlier blocks opened by Show earlier or the message navigator. */
  from?: number
}

// Scroll events do not need to notify React or write to disk.
const readingPositions = new Map<string, ReadingPosition>()

export const readingPosition = (key: string | undefined) =>
  key ? readingPositions.get(key) : undefined

export function rememberReadingPosition(key: string, patch: Partial<ReadingPosition>) {
  readingPositions.set(key, { top: 0, following: true, ...readingPositions.get(key), ...patch })
}
