import type { SessionView } from './replica.ts'

export interface SessionMatch {
  sessionId: string
  /** Where the words were found. */
  field: 'title' | 'message'
  /** A short piece of the matching text around the first hit (messages only). */
  snippet?: string
  /** Who wrote the matching message. */
  role?: 'user' | 'assistant'
}

const normalize = (s: string) => s.toLocaleLowerCase()

/**
 * Finds sessions by title or by anything said in them. Every word of the query has to appear
 * (in any order) in the same title or message; the newest matching message gives the snippet.
 */
export function searchSessions(
  sessions: Iterable<SessionView>,
  query: string,
  options: { limit?: number; snippetChars?: number } = {},
): SessionMatch[] {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const limit = options.limit ?? 50
  const width = options.snippetChars ?? 90
  const hits = (text: string) => {
    const lower = normalize(text)
    return words.every((w) => lower.includes(w))
  }
  const out: SessionMatch[] = []
  for (const view of sessions) {
    if (out.length >= limit) break
    if (hits(view.title)) {
      out.push({ sessionId: view.id, field: 'title' })
      continue
    }
    const message = view.items.findLast(
      (item): item is Extract<typeof item, { kind: 'message' }> =>
        item.kind === 'message' && hits(item.text),
    )
    if (message) {
      out.push({
        sessionId: view.id,
        field: 'message',
        role: message.role,
        snippet: snippetAround(message.text, words[0]!, width),
      })
    }
  }
  return out
}

/** `width` characters of `text` around the first `word`, on one line, with ellipses. */
export function snippetAround(text: string, word: string, width = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = normalize(flat).indexOf(normalize(word))
  if (flat.length <= width) return flat
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width))
  const piece = flat.slice(start, start + width).trim()
  return `${start > 0 ? '…' : ''}${piece}${start + width < flat.length ? '…' : ''}`
}
