import { memo, useMemo, type ReactNode } from 'react'
import { splitStreamingMarkdown } from '@beddcode/client-runtime'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownAnchor } from '../features/links/links.tsx'
import { remarkPathLinks } from '../features/links/remarkPathLinks.ts'

// Held outside the component so the same objects reach ReactMarkdown every time.
const plugins = [remarkGfm, remarkPathLinks]
const components: Components = {
  a: ({ node: _node, ...props }) => <MarkdownAnchor {...props} />,
}

/**
 * Assistant text. Raw HTML is never rendered. Web links open in the browser pane (the system
 * browser with Ctrl/⌘); file paths inside the session folder open in an editor or the Files pane.
 * Text that has not changed is not parsed again, which matters while another message streams.
 */
const MarkdownBody = memo(function MarkdownBody({
  text,
  cache = true,
}: {
  text: string
  cache?: boolean
}) {
  return <>{render(text, cache)}</>
})

// Finished text only changes when it is edited, but a thread remounts every time you switch to it,
// and each remount parsed every visible message again. react-markdown's default export is a plain
// function (no hooks) that returns the element tree, so the tree is kept by its text. Elements are
// immutable, the remark plugin is a pure function of the text, and the session a link belongs to is
// read when the link component renders, so one tree can serve any thread that shows this text.
const CACHE_ENTRIES = 400
const CACHE_MAX_CHARS = 20_000
const parsed = new Map<string, ReactNode>()

function render(text: string, cache: boolean): ReactNode {
  const keep = cache && text.length <= CACHE_MAX_CHARS
  if (keep) {
    const hit = parsed.get(text)
    if (hit !== undefined) {
      // Most recently used goes last, so the oldest entry is the one dropped.
      parsed.delete(text)
      parsed.set(text, hit)
      return hit
    }
  }
  const tree = ReactMarkdown({ remarkPlugins: plugins, components, children: text })
  if (keep) {
    parsed.set(text, tree)
    if (parsed.size > CACHE_ENTRIES) parsed.delete(parsed.keys().next().value!)
  }
  return tree
}

export const Markdown = memo(function Markdown({
  text,
  live = false,
}: {
  text: string
  live?: boolean
}) {
  const [head, tail] = useMemo(() => {
    // Reference links and footnotes can refer to definitions elsewhere in the document.
    if (!live || /^ {0,3}\[[^\]]+\]:/m.test(text)) return ['', text]
    return splitStreamingMarkdown(text)
  }, [text, live])
  return (
    <div className="md">
      {head && <MarkdownBody key="head" text={head} />}
      {head ? '\n' : null}
      {/* A streaming tail changes with every delta, so only finished text is kept. */}
      <MarkdownBody key="tail" text={tail} cache={!live} />
    </div>
  )
})
