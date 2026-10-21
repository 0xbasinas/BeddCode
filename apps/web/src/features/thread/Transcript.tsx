import { useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  FileText,
  FolderOpen,
  Paperclip,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  Check,
  Shield,
  X,
  CirclePause,
} from 'lucide-react'
import type { TranscriptItem } from '@beddcode/client-runtime'
import { Markdown } from '../../ui/Markdown.tsx'
import { PatchView } from '../../ui/PatchView.tsx'
import { buildBlocks, totalChanges, type EditedFile } from './blocks.ts'
import { folderName } from '../../ui/format.ts'
import { FileIcon } from '../files/FileIcon.tsx'

type Item = TranscriptItem
type ApprovalItem = Extract<Item, { kind: 'approval' }>

export function Transcript({
  items,
  cwd,
  onApprove,
  onOpenFile,
}: {
  items: Item[]
  cwd: string
  onApprove(requestId: string, optionId: string): void | Promise<void>
  onOpenFile?(path: string): void
}) {
  const blocks = buildBlocks(items)
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'edits')
          return (
            <EditedFilesCard key={block.id} files={block.files} cwd={cwd} onOpenFile={onOpenFile} />
          )
        if (block.item.kind === 'tool') {
          const previous = blocks[index - 1]
          if (previous?.kind === 'item' && previous.item.kind === 'tool') return null
          const tools: Extract<Item, { kind: 'tool' }>[] = []
          for (let i = index; i < blocks.length; i++) {
            const next = blocks[i]
            if (next?.kind !== 'item' || next.item.kind !== 'tool') break
            tools.push(next.item)
          }
          const last = tools.at(-1)
          return (
            <div className="tool-group" key={block.item.id}>
              {tools.map((tool) => (
                <ToolRow key={tool.id} item={tool} />
              ))}
              {last?.at && (
                <time className="tool-time" dateTime={new Date(last.at).toISOString()}>
                  {new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
              )}
            </div>
          )
        }
        return <ItemView key={block.item.id} item={block.item} cwd={cwd} onApprove={onApprove} />
      })}
    </>
  )
}

function ItemView({
  item,
  cwd,
  onApprove,
}: {
  item: Item
  cwd: string
  onApprove(requestId: string, optionId: string): void | Promise<void>
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
      return <ApprovalCard item={item} cwd={cwd} onApprove={onApprove} />
    case 'error':
      return <div className="msg error">{item.message}</div>
    case 'notice':
      return (
        <div className="turn-notice">
          <CirclePause size={16} />
          <span>{item.message}</span>
        </div>
      )
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
      <code>
        {item.status === 'cancelled' ? item.title.replace(/^Running\s+/, 'Stopped: ') : item.title}
      </code>
    </div>
  )
}

export function EditedFilesCard({
  files,
  cwd,
  onOpenFile,
}: {
  files: EditedFile[]
  cwd: string
  onOpenFile?(path: string): void
}) {
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
          <FileDiff
            key={file.path}
            file={file}
            cwd={cwd}
            initiallyOpen={i === 0}
            onOpenFile={onOpenFile}
          />
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
  onOpenFile,
}: {
  file: EditedFile
  cwd: string
  initiallyOpen: boolean
  onOpenFile?(path: string): void
}) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <div className="file-diff">
      <div className="file-row" title={file.path}>
        <button className="file-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <FileIcon name={file.path} size={15} />
          <span className="file-path">{displayPath(file.path, cwd) || folderName(file.path)}</span>
          <span className="stat">
            <span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
          </span>
        </button>
        {onOpenFile && (
          <button
            className="icon-btn file-open"
            aria-label={`Open ${displayPath(file.path, cwd)} in editor`}
            onClick={() => onOpenFile(displayPath(file.path, cwd))}
          >
            <FolderOpen size={14} />
          </button>
        )}
        <button
          className="icon-btn file-disclosure"
          aria-label={`${open ? 'Collapse' : 'Expand'} diff for ${displayPath(file.path, cwd)}`}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      {open && <PatchView patch={file.patch} />}
    </div>
  )
}

export function ApprovalCard({
  item,
  onApprove,
  cwd,
}: {
  item: ApprovalItem
  onApprove(requestId: string, optionId: string): void | Promise<void>
  cwd?: string
}) {
  const answered = item.options.find((o) => o.id === item.resolvedOptionId)
  const firstAllow = item.options.find((o) => o.kind === 'allow')
  const firstDeny = item.options.find((o) => o.kind === 'deny')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const submitting = useRef(false)
  const resolved = Boolean(item.resolvedOptionId) || Boolean(item.cancelled)
  const state = item.cancelled
    ? 'cancelled'
    : !resolved
      ? 'pending'
      : answered?.kind === 'deny'
        ? 'denied'
        : answered?.kind === 'allow'
          ? 'allowed'
          : 'answered'
  const answer = async (optionId: string) => {
    if (submitting.current || resolved) return
    submitting.current = true
    setBusy(optionId)
    setError(undefined)
    try {
      await onApprove(item.requestId, optionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      submitting.current = false
      setBusy(undefined)
    }
  }
  return (
    <div className={`approval ${state}`}>
      <div className="approval-state">
        {state === 'pending' ? (
          <Shield size={15} />
        ) : state === 'allowed' ? (
          <Check size={15} />
        ) : state === 'denied' ? (
          <X size={15} />
        ) : (
          <CirclePause size={15} />
        )}
        {state === 'pending'
          ? 'Approval needed'
          : state === 'allowed'
            ? answered?.label === 'Always for this session'
              ? 'Allowed for this session'
              : 'Allowed'
            : state === 'denied'
              ? 'Denied'
              : state === 'cancelled'
                ? 'Request cancelled'
                : (answered?.label ?? 'Answered')}
      </div>
      <div className="approval-title" title={item.title}>
        {item.title.startsWith('Running ') ? 'Run this command?' : item.title}
      </div>
      {item.detail && (
        <details className="approval-details" open={!resolved}>
          <summary>Details</summary>
          <pre>
            <code>{item.detail}</code>
          </pre>
        </details>
      )}
      {cwd && (
        <code className="approval-cwd" title={cwd}>
          {cwd}
        </code>
      )}
      {!resolved && (
        <div className="approval-actions">
          {item.options.map((o) => (
            <button
              key={o.id}
              id={`approval-${item.id}-${o.id}`}
              className={o.id === firstAllow?.id ? 'allow' : ''}
              disabled={Boolean(busy)}
              onClick={() => void answer(o.id)}
            >
              {busy === o.id ? 'Sending…' : o.label}
              {o.id === firstAllow?.id && <kbd>Enter</kbd>}
              {o.id === firstDeny?.id && <kbd>Esc</kbd>}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
