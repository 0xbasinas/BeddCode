// Match scoring adapted from T3 Code's search ranking
// (https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/searchRanking.ts).
// MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// Changes for BeddCode: accent/case folding, multi-word queries scored per word against a label
// and its keywords, and one ranking function for the command palette.

/** Lower case, without accents, so "ρυθμισεις" finds "Ρυθμίσεις" and "cafe" finds "Café". */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[\u2018\u2019]/g, "'")
}

/** Letters of `query` in order inside `value`; lower is better, null when they are not all there. */
export function scoreSubsequence(value: string, query: string): number | null {
  if (!query) return 0
  let q = 0
  let first = -1
  let previous = -1
  let gaps = 0
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== query[q]) continue
    if (first === -1) first = i
    if (previous !== -1) gaps += i - previous - 1
    previous = i
    q += 1
    if (q === query.length) {
      const span = i - first + 1 - query.length
      return first * 2 + gaps * 3 + span + Math.min(64, value.length - query.length)
    }
  }
  return null
}

const BOUNDARIES = [' ', '-', '_', '/', '.', ':']

/** How well one folded word matches one folded text; lower is better, null for no match. */
export function scoreWord(value: string, word: string): number | null {
  if (!value || !word) return null
  const length = Math.min(64, Math.max(0, value.length - word.length))
  if (value === word) return 0
  if (value.startsWith(word)) return 100 + length
  let boundary: number | null = null
  for (const marker of BOUNDARIES) {
    const at = value.indexOf(marker + word)
    if (at !== -1 && (boundary === null || at + 1 < boundary)) boundary = at + 1
  }
  if (boundary !== null) return 200 + boundary * 2 + length
  const at = value.indexOf(word)
  if (at !== -1) return 300 + at * 2 + length
  const fuzzy = scoreSubsequence(value, word)
  return fuzzy === null ? null : 600 + fuzzy
}

export interface RankableCommand {
  id: string
  label: string
  /** Extra words that should find the command (synonyms, the project, the agent…). */
  keywords?: readonly string[]
  /** Added to the score: lets a group (actions before sessions) win ties. */
  bias?: number
}

/**
 * Commands matching every word of the query, best first. A word that hits the label scores
 * better than one that only hits a keyword. An empty query keeps the given order.
 */
export function rankCommands<T extends RankableCommand>(
  items: readonly T[],
  query: string,
  limit = 50,
): T[] {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return items.slice(0, limit)
  const scored: { item: T; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const label = foldForSearch(item.label)
    const keywords = (item.keywords ?? []).map(foldForSearch)
    let total = item.bias ?? 0
    for (const word of words) {
      let best = scoreWord(label, word)
      for (const keyword of keywords) {
        const s = scoreWord(keyword, word)
        if (s !== null && (best === null || s + 50 < best)) best = s + 50
      }
      if (best === null) return
      total += best
    }
    scored.push({ item, score: total, index })
  })
  scored.sort((a, b) => a.score - b.score || a.index - b.index)
  return scored.slice(0, limit).map((s) => s.item)
}
