/** A line inside a list, table, quote or indented block: the block may go on after a blank line. */
const INSIDE_BLOCK = /^\s*(?:[-*+]\s|\d+[.)]\s|\||>|\s{2,}\S)/
/** A line indented under the block above it. */
const INDENTED = /^\s{2,}\S/

const fences = (text: string) => (text.match(/^\s*(?:```|~~~)/gm) ?? []).length

/**
 * Splits streaming Markdown into the part that will not change any more and the part still being
 * written, so the first can be drawn once and only the second again on every update. The split is
 * at a blank line outside a code fence that neither a list, a table nor a quote runs across; when
 * there is no such place the whole text is the tail.
 */
export function splitStreamingMarkdown(text: string): [head: string, tail: string] {
  let at = text.lastIndexOf('\n\n')
  while (at > 0) {
    const head = text.slice(0, at)
    const rest = text.slice(at).replace(/^\n+/, '')
    const before = head.slice(head.lastIndexOf('\n') + 1)
    const after = rest.slice(0, rest.indexOf('\n') === -1 ? undefined : rest.indexOf('\n'))
    if (fences(head) % 2 === 0 && !INSIDE_BLOCK.test(before) && !INDENTED.test(after) && rest)
      return [head, rest]
    at = text.lastIndexOf('\n\n', at - 1)
  }
  return ['', text]
}
