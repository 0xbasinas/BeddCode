import { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  FileText,
  Paperclip,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import type { TranscriptItem } from '@beddcode/client-runtime'
import { Markdown } from '../../ui/Markdown.tsx'
import { PatchView } from '../../ui/PatchView.tsx'
import { buildBlocks, totalChanges, type EditedFile } from './blocks.ts'
import { folderName } from '../../ui/format.ts'

type Item = TranscriptItem
type ApprovalItem = Extract<Item, { kind: 'approval' }>

export function Transcript({
  items,
  cwd,
  onApprove,
}: {
  items: Item[]
  cwd: string
  onApprove(requestId: string, optionId: string): void
}) {
  return (
    <>
      {buildBlocks(items).map((block) =>
        block.kind === 'edits' ? (
          <EditedFilesCard key={block.id} files={block.files} cwd={cwd} />
        ) : (
          <ItemView key={block.item.id} item={block.item} onApprove={onApprove} />
        ),
      )}
    </>
  )
}

function ItemView({
  item,
  onApprove,
}: {
  item: Item
  onApprove(requestId: string, optionId: string): void
}) {
  switch (item.kind) {
    case 'message':
      return item.role === 'user' ? (
        <div className="msg user">
          {item.attachments && item.attachments.length > 0 && (
            <div className="chips">
              {item.attachments.map((a) => (
                <span key={a.path} className="chip static">
                  <Paperclip size={12} /> {a.name}
                </span>
              ))}
            </div>
          )}
          {item.text && <div className="plain">{item.text}</div>}
        </div>
      ) : (
        <Markdown text={item.text} />
      )
    case 'tool':
      return <ToolRow item={item} />
    case 'approval':
      return <ApprovalCard item={item} onApprove={onApprove} />
    case 'error':
      return <div className="msg error">{item.message}</div>
    case 'diff':
      return null // grouped into the "Edited files" card
  }
}

const toolIcons = {
  command: SquareTerminal,
  read: FileText,
  edit: Pencil,
  search: Search,
  other: Wrench,
} as const

function ToolRow({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const Icon = toolIcons[item.toolKind]
  return (
    <div className={`tool ${item.status}`} title={item.output}>
      <Icon size={15} />
      <code>{item.title}</code>
    </div>
  )
}

export function EditedFilesCard({ files, cwd }: { files: EditedFile[]; cwd: string }) {
  const [open, setOpen] = useState(true)
  const { added, removed } = totalChanges(files)
  return (
    <div className="edits">
      <button className="edits-head" onClick={() => setOpen((o) => !o)}>
        <Pencil size={16} />
        <span>
          <strong>Edited {files.length === 1 ? '1 file' : `${files.length} files`}</strong>
          <span className="stat">
            <span className="add">+{added}</span> <span className="del">−{removed}</span>
          </span>
        </span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open &&
        files.map((file, i) => (
          <FileDiff key={file.path} file={file} cwd={cwd} initiallyOpen={i === 0} />
        ))}
    </div>
  )
}

/** Shows a path relative to the session folder when it lives inside it. */
function displayPath(file: string, cwd: string): string {
  const f = file.replace(/\\/g, '/')
  const c = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  return f.toLowerCase().startsWith(`${c.toLowerCase()}/`) ? f.slice(c.length + 1) : f
}

function FileDiff({
  file,
  cwd,
  initiallyOpen,
}: {
  file: EditedFile
  cwd: string
  initiallyOpen: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <div className="file-diff">
      <button className="file-row" onClick={() => setOpen((o) => !o)} title={file.path}>
        <FileText size={15} />
        <span className="file-path">{displayPath(file.path, cwd) || folderName(file.path)}</span>
        <span className="stat">
          <span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
        </span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && <PatchView patch={file.patch} />}
    </div>
  )
}

export function ApprovalCard({
  item,
  onApprove,
}: {
  item: ApprovalItem
  onApprove(requestId: string, optionId: string): void
}) {
  const answered = item.options.find((o) => o.id === item.resolvedOptionId)
  const firstAllow = item.options.find((o) => o.kind === 'allow')
  const firstDeny = item.options.find((o) => o.kind === 'deny')
  return (
    <div className="approval">
      <div className="approval-title">{item.title}</div>
      {item.detail && <code className="approval-detail">{item.detail}</code>}
      {answered ? (
        <div className="approval-done">{answered.label}</div>
      ) : (
        <div className="approval-actions">
          {item.options.map((o) => (
            <button
              key={o.id}
              className={o.id === firstAllow?.id ? 'allow' : ''}
              onClick={() => onApprove(item.requestId, o.id)}
            >
              {o.label}
              {o.id === firstAllow?.id && <kbd>Enter</kbd>}
              {o.id === firstDeny?.id && <kbd>Esc</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
