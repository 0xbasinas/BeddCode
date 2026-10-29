import { findTextLinks, wholePath, type PathLink } from '@beddcode/client-runtime'

/** The few mdast fields this plugin reads and writes. */
interface MdNode {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: MdNode[]
  data?: { hProperties?: Record<string, string | number> }
}

/** Never looked into: code is shown as written, and links already go somewhere. */
const SKIP = new Set(['code', 'link', 'linkReference', 'html', 'definition', 'image'])

/** Marks a path for the `a` renderer, which checks it exists before making it clickable. */
export function pathLinkNode(link: Pick<PathLink, 'path' | 'line' | 'column'>, children: MdNode[]) {
  const hProperties: Record<string, string | number> = { dataBdcPath: link.path }
  if (link.line) hProperties.dataBdcLine = link.line
  if (link.column) hProperties.dataBdcColumn = link.column
  return { type: 'link', url: '', title: null, children, data: { hProperties } }
}

function splitText(value: string): MdNode[] {
  const links = findTextLinks(value).filter((l): l is PathLink => l.kind === 'path')
  if (!links.length) return [{ type: 'text', value }]
  const out: MdNode[] = []
  let at = 0
  for (const link of links) {
    if (link.start > at) out.push({ type: 'text', value: value.slice(at, link.start) })
    out.push(pathLinkNode(link, [{ type: 'text', value: link.text }]))
    at = link.end
  }
  if (at < value.length) out.push({ type: 'text', value: value.slice(at) })
  return out
}

function walk(node: MdNode) {
  if (!node.children || SKIP.has(node.type)) return
  const children: MdNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value) children.push(...splitText(child.value))
    else if (child.type === 'inlineCode' && child.value) {
      // `src/a.ts:3` on its own is a path; `cat src/a.ts` is a command and stays as it is.
      const link = wholePath(child.value)
      children.push(link ? pathLinkNode(link, [child]) : child)
    } else {
      walk(child)
      children.push(child)
    }
  }
  node.children = children
}

/**
 * Turns file paths in prose and in path-only code spans into links the renderer can check and open.
 * Code blocks, and text that is already a link, are left alone.
 */
export function remarkPathLinks() {
  return (tree: MdNode) => walk(tree)
}
