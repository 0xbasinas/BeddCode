import type { CSSProperties, ReactNode } from 'react'
import { Paperclip } from 'lucide-react'

/** Separate buttons keep both opening and attaching reachable by keyboard. */
export function FileRow({
  path,
  active,
  style,
  onOpen,
  onAttach,
  children,
}: {
  path: string
  active?: boolean
  style?: CSSProperties
  onOpen(): void
  onAttach(): void
  children: ReactNode
}) {
  return (
    <div className={`tree-file-row ${active ? 'active' : ''}`}>
      <button className="tree-row file" style={style} onClick={onOpen} title={path}>
        {children}
      </button>
      <button
        className="icon-btn attach-file"
        aria-label={`Attach ${path}`}
        title="Attach saved file to message"
        onClick={onAttach}
      >
        <Paperclip size={14} />
      </button>
    </div>
  )
}
