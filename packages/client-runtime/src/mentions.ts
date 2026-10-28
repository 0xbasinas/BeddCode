/** An `@file` being typed: where it starts in the message and what follows the `@` so far. */
export interface Mention {
  start: number
  query: string
}

/** The `@mention` the caret is in, if any: an `@` at the start or after whitespace. */
export function mentionAt(text: string, caret: number): Mention | undefined {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  if (!match) return undefined
  return { start: caret - match[2]!.length - 1, query: match[2]! }
}

/** The message with the mention replaced by the chosen path, and where the caret goes. */
export function insertMention(
  text: string,
  caret: number,
  mention: Mention,
  path: string,
  dir = false,
): { text: string; caret: number } {
  const quoted = /\s/.test(path) ? `"${path}"` : path
  // A folder is left open, so the next keystroke browses into it.
  const inserted = dir ? `@${path}/` : `@${quoted} `
  const rest = dir ? text.slice(caret) : text.slice(caret).replace(/^ /, '')
  return {
    text: text.slice(0, mention.start) + inserted + rest,
    caret: mention.start + inserted.length,
  }
}
