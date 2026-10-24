import { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Paperclip,
  Pencil,
  CirclePause,
  GitFork,
} from 'lucide-react'
import type { TranscriptItem } from '@beddcode/client-runtime'
import { Markdown } from '../../ui/Markdown.tsx'
import { PatchView } from '../../ui/PatchView.tsx'
import { buildBlocks, totalChanges, type EditedFile } from '@beddcode/client-runtime'
import { folderName } from '../../ui/format.ts'
import { FileIcon } from '../files/FileIcon.tsx'
import { ApprovalCard } from './ApprovalCard.tsx'
import { QuestionCard } from './QuestionCard.tsx'
import { ToolGroup } from './ToolCalls.tsx'
import { AgentToolCard } from './AgentToolCard.tsx'
import { isAgentTool } from '@beddcode/client-runtime'
import { TurnChangesCard } from './TurnChanges.tsx'

type Item = TranscriptItem

export function Transcript({
  items,
  cwd,
  onApprove,
  onAnswer,
  onOpenFile,
  onFork,
  completedTurns = 0,
  changes,
  sessionId,
  hostKey,
}: {
  items: Item[]
  cwd: string
  /** This session and its host, so calls to the agent tools can follow the sessions they start. */
  sessionId?: string
  hostKey?: string
  /** Where turn changes are read and undone; without it their cards are not shown. */
  changes?: { hostKey: string; sessionId: string; idle: boolean }
  onApprove(requestId: string, optionId: string): void | Promise<void>
  onAnswer?(requestId: string, answers?: Record<string, string[]>): void | Promise<void>
  onOpenFile?(path: string): void
  /** Starts a session that continues this one up to the end of the given turn. */
  onFork?(turnNo: number): void | Promise<void>
  /** Turns that have finished; a fork can only end after one of them. */
  completedTurns?: number
}) {
  const blocks = buildBlocks(items)
  const latestChanges = items.findLast((i) => i.kind === 'changes')?.id
  // The last reply of each turn is where "fork from here" goes.
  const lastReplyOfTurn = new Map<number, number>()
  blocks.forEach((b, i) => {
    if (
      b.kind === 'item' &&
      b.item.kind === 'message' &&
      b.item.role === 'assistant' &&
      b.item.turnNo
    ) {
      lastReplyOfTurn.set(b.item.turnNo, i)
    }
  })
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'edits')
          return (
            <EditedFilesCard key={block.id} files={block.files} cwd={cwd} onOpenFile={onOpenFile} />
          )
        if (block.item.kind === 'changes') {
          return changes ? (
            <TurnChangesCard
              key={block.item.id}
              item={block.item}
              hostKey={changes.hostKey}
              sessionId={changes.sessionId}
              canUndo={changes.idle && block.item.id === latestChanges}
              onOpenFile={onOpenFile}
            />
          ) : null
        }
        if (block.item.kind === 'tool') {
          // Starting and managing other agents gets cards of its own, outside the runs of tools.
          if (isAgentTool(block.item)) {
            return (
              <AgentToolCard
                key={block.item.id}
                tool={block.item}
                parentId={sessionId}
                hostKey={hostKey ?? changes?.hostKey}
              />
            )
          }
          const plainTool = (b: (typeof blocks)[number] | undefined) =>
            b?.kind === 'item' && b.item.kind === 'tool' && !isAgentTool(b.item)
          if (plainTool(blocks[index - 1])) return null
          const tools: Extract<Item, { kind: 'tool' }>[] = []
          for (let i = index; i < blocks.length; i++) {
            const next = blocks[i]
            if (!plainTool(next) || next?.kind !== 'item' || next.item.kind !== 'tool') break
            tools.push(next.item)
          }
          return <ToolGroup key={block.item.id} tools={tools} />
        }
        const turnNo = block.item.kind === 'message' ? block.item.turnNo : undefined
        const canFork =
          onFork !== undefined &&
          turnNo !== undefined &&
          lastReplyOfTurn.get(turnNo) === index &&
          turnNo <= completedTurns
        return (
          <div key={block.item.id} className={canFork ? 'has-fork' : undefined}>
            <ItemView item={block.item} cwd={cwd} onApprove={onApprove} onAnswer={onAnswer} />
            {canFork && (
              <button
                className="fork-here"
                title="Fork from here: start a new session from this point"
                aria-label="Fork from here"
                onClick={() => void onFork(turnNo)}
              >
                <GitFork size={14} />
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

function ItemView({
  item,
  cwd,
  onApprove,
  onAnswer,
}: {
  item: Item
  cwd: string
  onApprove(requestId: string, optionId: string): void | Promise<void>
  onAnswer?(requestId: string, answers?: Record<string, string[]>): void | Promise<void>
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
      return <ToolGroup tools={[item]} />
    case 'approval':
      return <ApprovalCard item={item} cwd={cwd} onApprove={onApprove} />
    case 'question':
      return onAnswer ? <QuestionCard item={item} onAnswer={onAnswer} /> : null
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
    case 'changes':
      return null // drawn by Transcript, which knows the host
  }
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
