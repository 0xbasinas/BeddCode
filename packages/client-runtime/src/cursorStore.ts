/** Cursor positions include the host log and global sequence covered by the replica. */
export interface CursorPosition {
  sessionSeq: number
  seq: number
}
export interface CursorSnapshot {
  logId?: string
  sessions: Record<string, CursorPosition>
}
export interface CursorStore {
  load(host: string): Promise<CursorSnapshot | null>
  save(host: string, snapshot: CursorSnapshot): Promise<void>
}

/** Adapts localStorage or AsyncStorage to the same bounded, per-host format. */
export function createCursorStore(storage: {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): unknown | Promise<unknown>
}): CursorStore {
  const key = (host: string) => `beddcode.cursors.${encodeURIComponent(host)}`
  return {
    async load(host) {
      try {
        const raw = await storage.getItem(key(host))
        const data = raw ? JSON.parse(raw) : null
        if (!data || typeof data.sessions !== 'object' || !data.sessions) return null
        const sessions: Record<string, CursorPosition> = {}
        for (const [id, value] of Object.entries(data.sessions).slice(-200)) {
          const p = value as CursorPosition
          if (
            p &&
            Number.isSafeInteger(p.sessionSeq) &&
            p.sessionSeq > 0 &&
            Number.isSafeInteger(p.seq) &&
            p.seq > 0
          )
            sessions[id] = { sessionSeq: p.sessionSeq, seq: p.seq }
        }
        return { logId: typeof data.logId === 'string' ? data.logId : undefined, sessions }
      } catch {
        return null
      }
    },
    async save(host, snapshot) {
      try {
        await storage.setItem(
          key(host),
          JSON.stringify({
            ...snapshot,
            sessions: Object.fromEntries(Object.entries(snapshot.sessions).slice(-200)),
          }),
        )
      } catch {
        /* Storage is optional. */
      }
    },
  }
}
