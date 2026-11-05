import { composerDraftKey } from '../composer/drafts.ts'

export const threadKey = composerDraftKey

interface ReadingPosition {
  top: number
  following: boolean
  /** Earlier blocks opened by Show earlier or the message navigator. */
  from?: number
}

const STORAGE_KEY = 'beddcode.readingPositions'
const KEEP = 60
const SAVE_DELAY_MS = 800

function load(): Map<string, ReadingPosition> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return new Map()
    return new Map(
      raw.filter(
        (row): row is [string, ReadingPosition] =>
          Array.isArray(row) &&
          typeof row[0] === 'string' &&
          typeof row[1]?.top === 'number' &&
          typeof row[1]?.following === 'boolean',
      ),
    )
  } catch {
    return new Map()
  }
}

// Scroll events do not notify React; positions are written to disk lazily, so an app restart
// (a rebuilt desktop process, an update) brings the reader back to where they were.
const readingPositions = load()
let saveTimer: ReturnType<typeof setTimeout> | undefined

function scheduleSave() {
  if (saveTimer !== undefined) return
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    try {
      globalThis.localStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify([...readingPositions].slice(-KEEP)),
      )
    } catch {
      // Storage may be full or blocked; the position is simply not kept.
    }
  }, SAVE_DELAY_MS)
}

export const readingPosition = (key: string | undefined) =>
  key ? readingPositions.get(key) : undefined

export function rememberReadingPosition(key: string, patch: Partial<ReadingPosition>) {
  const next = { top: 0, following: true, ...readingPositions.get(key), ...patch }
  // Most recently touched last, so the oldest are the ones dropped.
  readingPositions.delete(key)
  readingPositions.set(key, next)
  scheduleSave()
}
