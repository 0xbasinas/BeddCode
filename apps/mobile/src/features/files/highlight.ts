import { colors } from '@/theme/tokens'

export interface Span {
  text: string
  color: string
}

const KEYWORDS = new Set(
  (
    'import export from default as const let var function async await return if else for while do switch case break continue ' +
    'new class extends implements interface type enum public private protected static readonly try catch finally throw typeof ' +
    'instanceof in of void yield def lambda pass with raise None True False self fn mut pub use mod impl struct trait match ' +
    'package func go defer chan select range'
  ).split(' '),
)

const LITERALS = new Set(['null', 'undefined', 'true', 'false', 'NaN'])

const PALETTE = {
  keyword: '#bb9af7',
  string: colors.success,
  number: colors.accent,
  comment: colors.faint,
  literal: colors.accent,
  type: '#7aa2f7',
  plain: colors.textSecondary,
}

const TOKEN =
  /(\/\/.*$|#(?![![]).*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g

/** A light, language-agnostic colouring of one line; enough to read code, not a parser. */
export function highlightLine(line: string, ext: string): Span[] {
  if (['md', 'txt', 'lock'].includes(ext)) return [{ text: line, color: PALETTE.plain }]
  const spans: Span[] = []
  let last = 0
  for (const m of line.matchAll(TOKEN)) {
    const at = m.index ?? 0
    if (at > last) spans.push({ text: line.slice(last, at), color: PALETTE.plain })
    const [text, comment, string, number, word] = m
    let color: string = PALETTE.plain
    if (comment) color = PALETTE.comment
    else if (string) color = PALETTE.string
    else if (number) color = PALETTE.number
    else if (word) {
      if (KEYWORDS.has(word)) color = PALETTE.keyword
      else if (LITERALS.has(word)) color = PALETTE.literal
      else if (/^[A-Z]/.test(word)) color = PALETTE.type
    }
    spans.push({ text, color })
    last = at + text.length
  }
  if (last < line.length) spans.push({ text: line.slice(last), color: PALETTE.plain })
  return spans
}
