import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Held outside the component so the same objects reach ReactMarkdown every time.
const plugins = [remarkGfm]
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

/**
 * Assistant text. Raw HTML is never rendered; links open outside the app. Text that has not
 * changed is not parsed again, which matters while another message streams below it.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
