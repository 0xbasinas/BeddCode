import { memo, useMemo } from 'react'
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
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  )
})

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
      <MarkdownBody key="tail" text={tail} />
    </div>
  )
})
