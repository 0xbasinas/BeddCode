/**
 * Finds the web addresses and file paths in agent text, so they can be made clickable. Paths are
 * only candidates here: the host says which of them exist inside the session folder.
 */

export interface UrlLink {
  kind: 'url'
  start: number
  end: number
  text: string
  url: string
}

export interface PathLink {
  kind: 'path'
  start: number
  end: number
  /** The whole match, `src/a.ts:12:3` included. */
  text: string
  /** Just the path, as written (`src/a.ts`, `C:\\repo\\a.ts`, `./a.ts`). */
  path: string
  line?: number
  column?: number
}

export type TextLink = UrlLink | PathLink

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g

// A path: an optional root (`C:\`, `\\server`, `~/`, `./`, `../`, `/`), folder names separated by
// slashes or backslashes, and a last name that does not end in a dot (so a full stop after it is
// left out). Then an optional location: `:12`, `:12:3`, `#L12`, `#L12C3`, `#L12-L20`.
const NAME = String.raw`[\w@+\-.$~]`
const PATH_RE = new RegExp(
  String.raw`(?<![\w/\\.:@$~-])` +
    String.raw`((?:[A-Za-z]:[\\/]|\\\\|~/|\.{1,2}[\\/]|/)?(?:${NAME}+[\\/])*${NAME}*[\w@+\-$])` +
    String.raw`(?:(?::|#L)(\d+)(?:(?::|C)(\d+))?(?:-L?\d+)?)?`,
  'g',
)

/** A file name with an extension (`a.ts`, `.env`, `Dockerfile` is not one). */
// One-letter extensions are few (`main.c`, `a.h`); others (`e.g`) are prose.
const HAS_EXTENSION = /(?:^|[\\/])[\w@+\-.$~]*\.(?:[A-Za-z][\w-]{1,15}|[chmrsdvCHRSV])$/
const HAS_SEPARATOR = /[\\/]/

/** Trims what usually follows an address in prose: a full stop, a closing bracket with no opener. */
function trimUrl(url: string): string {
  let out = url.replace(/[.,;:!?*_]+$/, '')
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
  ] as const) {
    while (out.endsWith(close) && count(out, close) > count(out, open)) {
      out = out.slice(0, -1).replace(/[.,;:!?*_]+$/, '')
    }
  }
  return out
}

const count = (s: string, ch: string) => s.split(ch).length - 1

/** Whether `path` looks enough like a file path to ask the host about it. */
export function looksLikePath(path: string): boolean {
  if (path.length < 2 || path.length > 1024) return false
  if (/^\d[\d.]*$/.test(path)) return false // a version or a number
  if (/^\/+$/.test(path) || path === '~/') return false
  // One name with no folder needs an extension (`math.ts`), or every word would be a candidate.
  // An email address is not a file.
  if (!HAS_SEPARATOR.test(path)) return !path.includes('@') && HAS_EXTENSION.test(path)
  return true
}

/** The web addresses and path candidates in `text`, in order and never overlapping. */
export function findTextLinks(text: string): TextLink[] {
  const links: TextLink[] = []
  const taken: [number, number][] = []
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    if (url.length <= 'https://'.length) continue
    const start = m.index
    links.push({ kind: 'url', start, end: start + url.length, text: url, url })
    taken.push([start, start + m[0].length])
  }
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index
    const end = start + m[0].length
    if (taken.some(([a, b]) => start < b && end > a)) continue
    const path = m[1]!
    if (!looksLikePath(path)) continue
    const line = m[2] ? Number(m[2]) : undefined
    const column = m[3] ? Number(m[3]) : undefined
    links.push({
      kind: 'path',
      start,
      end,
      text: m[0],
      path,
      ...(line ? { line } : {}),
      ...(line && column ? { column } : {}),
    })
  }
  return links.sort((a, b) => a.start - b.start)
}

/** `text` when the whole of it is one path (an inline code span like `src/a.ts:3`), else null. */
export function wholePath(text: string): PathLink | null {
  const trimmed = text.trim()
  const links = findTextLinks(trimmed)
  const only = links.length === 1 ? links[0] : undefined
  return only?.kind === 'path' && only.start === 0 && only.end === trimmed.length ? only : null
}

/**
 * Reads a Markdown link target that names a file rather than a page: `src/a.ts`, `src/a.ts#L3`,
 * `./a.ts:3`, `file:///repo/a.ts`, `C:\repo\a.ts`. Web addresses and other schemes give null.
 */
export function pathFromHref(href: string): Omit<PathLink, 'start' | 'end' | 'text'> | null {
  let target = href.trim()
  if (!target || target.startsWith('#') || target.startsWith('//')) return null
  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target)
      let path = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1) // file:///C:/repo
      target = path + url.hash
    } catch {
      return null
    }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(target)) {
    // A scheme of two letters or more (a single letter is a Windows drive).
    return null
  }
  let decoded = target
  try {
    decoded = decodeURIComponent(target)
  } catch {
    // Not percent-encoded after all.
  }
  const hash = /#L(\d+)(?:C(\d+))?(?:-L?\d+)?$/.exec(decoded)
  const colon = hash ? null : /:(\d+)(?::(\d+))?$/.exec(decoded)
  const loc = hash ?? colon
  const path = (loc ? decoded.slice(0, loc.index) : decoded).replace(/[?#].*$/, '')
  if (!path) return null
  const line = loc?.[1] ? Number(loc[1]) : undefined
  const column = loc?.[2] ? Number(loc[2]) : undefined
  return {
    kind: 'path',
    path,
    ...(line ? { line } : {}),
    ...(line && column ? { column } : {}),
  }
}
