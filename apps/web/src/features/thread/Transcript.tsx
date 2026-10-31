import { elapsedLabel } from '@beddcode/client-runtime'
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AttachmentImage, isImageName } from '../composer/AttachmentImage.tsx'
import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Paperclip,
  Pencil,
  CirclePause,
  GitFork,
  FoldVertical,
  LoaderCircle,
} from 'lucide-react'
import type { TranscriptItem } from '@beddcode/client-runtime'
import { Markdown } from '../../ui/Markdown.tsx'
import { INLINE_PATCH_LINES, PatchView } from '../../ui/PatchView.tsx'
import { createBlockBuilder, totalChanges, type EditedFile } from '@beddcode/client-runtime'
import { folderName } from '../../ui/format.ts'
import { FileIcon } from '../files/FileIcon.tsx'
import { ApprovalCard } from './ApprovalCard.tsx'
import { QuestionCard } from './QuestionCard.tsx'
import { ToolGroup } from './ToolCalls.tsx'
import { AgentRunCard } from './AgentToolCard.tsx'
import { isAgentTool, isBrowserTool } from '@beddcode/client-runtime'
import { BrowserToolCard } from './BrowserToolCard.tsx'
import { TurnChangesCard } from './TurnChanges.tsx'
import { readingPosition, rememberReadingPosition } from './threadState.ts'

type Item = TranscriptItem

/** A long thread draws only its latest blocks at first; earlier ones are added on request. */
const FIRST_BLOCKS = 80
const MORE_BLOCKS = 120

export const Transcript = memo(function Transcript({
  items,
  cwd,
  onApprove,
  onAnswer,
  onOpenFile,
  onFork,
  completedTurns = 0,
  turnDurations,
  stoppedTurn,
  changes,
  sessionId,
  hostKey,
  jumpTo,
  readingKey,
  live = false,
}: {
  items: Item[]
  cwd: string
  /** This session and its host, so calls to the agent tools can follow the sessions they start. */
  sessionId?: string
  hostKey?: string
  /** Where turn changes are read and undone; without it their cards are not shown. */
  changes?: { hostKey: string; sessionId: string; idle: boolean; worktree?: boolean }
  onApprove(requestId: string, optionId: string): void | Promise<void>
  onAnswer?(requestId: string, answers?: Record<string, string[]>): void | Promise<void>
  onOpenFile?(path: string): void
  /** Starts a session that continues this one up to the end of the given turn. */
  onFork?(turnNo: number): void | Promise<void>
  /** Turns that have finished; a fork can only end after one of them. */
  completedTurns?: number
  /** How long each finished turn ran, in ms, by turn number. */
  turnDurations?: Record<number, number>
  /** Draws this message if it is among the earlier, undrawn ones (a new `n` asks again). */
  jumpTo?: { id: string; n: number }
  readingKey?: string
  live?: boolean
  /** A turn the user stopped; its fork button stays visible instead of waiting for a hover. */
  stoppedTurn?: number
}) {
  const build = useMemo(() => createBlockBuilder(), [sessionId])
  const blocks = useMemo(() => build(items), [build, items])
  // Where drawing starts. It stays put as the thread grows, so rows already on screen keep their place.
  const [view, setWindow] = useState(() => ({
    id: sessionId,
    from: Math.min(
      readingPosition(readingKey)?.from ?? Math.max(0, blocks.length - FIRST_BLOCKS),
      Math.max(0, blocks.length - FIRST_BLOCKS),
    ),
  }))
  let from = view.from
  if (view.id !== sessionId) {
    from = Math.max(0, blocks.length - FIRST_BLOCKS)
    setWindow({ id: sessionId, from })
  }
  const jumped = useRef(jumpTo?.n)
  if (jumpTo && jumped.current !== jumpTo.n) {
    jumped.current = jumpTo.n
    const target = blocks.findIndex((b) => b.kind === 'item' && b.item.id === jumpTo.id)
    if (target >= 0 && target < from) {
      from = Math.max(0, target - 2)
      setWindow({ id: sessionId, from })
    }
  }
  useLayoutEffect(() => {
    if (readingKey) rememberReadingPosition(readingKey, { from })
  }, [readingKey, from])
  const showEarlier = () => setWindow({ id: sessionId, from: Math.max(0, from - MORE_BLOCKS) })
  const latestChanges = items.findLast((i) => i.kind === 'changes')?.id
  // "Fork from here" goes at the end of each turn: after its last reply or, when the turn was
  // stopped mid-work, after the tool calls that ran before the stop.
  const forkAnchor = useMemo(() => {
    const anchors = new Map<number, number>()
    let segment: { turnNo?: number; last: number } = { last: -1 }
    const close = () => {
      if (segment.turnNo !== undefined && segment.last >= 0)
        anchors.set(segment.turnNo, segment.last)
      segment = { last: -1 }
    }
    blocks.forEach((b, i) => {
      if (b.kind !== 'item') return
      if (b.item.kind === 'message' && b.item.role === 'user') return close()
      if (b.item.kind === 'message' && b.item.role === 'assistant' && b.item.turnNo)
        segment.turnNo = b.item.turnNo
      if (b.item.kind === 'message' || b.item.kind === 'tool') segment.last = i
    })
    close()
    return anchors
  }, [blocks])
  const forkButton = (turnNo: number) =>
    onFork && (
      <button
        className={`fork-here${turnNo === stoppedTurn ? ' always' : ''}`}
        title="Fork from here: start a new session from this point"
        aria-label="Fork from here"
        onClick={() => void onFork(turnNo)}
      >
        <GitFork size={14} />
      </button>
    )
  const forkable = (turnNo: number | undefined, last: number) =>
    onFork !== undefined &&
    turnNo !== undefined &&
    forkAnchor.get(turnNo) === last &&
    turnNo <= completedTurns
  return (
    <>
      {from > 0 && (
        <button className="show-earlier" onClick={showEarlier}>
          Show earlier ({from})
        </button>
      )}
      {blocks.map((block, index) => {
        if (index < from) return null
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
              cwd={cwd}
              canUndo={changes.idle && block.item.id === latestChanges}
              offerPr={changes.worktree && changes.idle && block.item.id === latestChanges}
              onOpenFile={onOpenFile}
            />
          ) : null
        }
        if (block.item.kind === 'tool') {
          // Starting and managing other agents gets cards of its own, outside the runs of tools.
          if (isAgentTool(block.item)) {
            // A run of them is one block.
            const agentTool = (b: (typeof blocks)[number] | undefined) =>
              b?.kind === 'item' && b.item.kind === 'tool' && isAgentTool(b.item)
            if (agentTool(blocks[index - 1])) return null
            const run: Extract<Item, { kind: 'tool' }>[] = []
            for (let i = index; i < blocks.length; i++) {
              const next = blocks[i]
              if (!agentTool(next) || next?.kind !== 'item' || next.item.kind !== 'tool') break
              run.push(next.item)
            }
            return (
              <AgentRunCard
                key={block.item.id}
                tools={run}
                parentId={sessionId}
                hostKey={hostKey ?? changes?.hostKey}
              />
            )
          }
          // A run of browser steps is one card.
          if (isBrowserTool(block.item)) {
            const browserTool = (b: (typeof blocks)[number] | undefined) =>
              b?.kind === 'item' && b.item.kind === 'tool' && isBrowserTool(b.item)
            if (browserTool(blocks[index - 1])) return null
            const run: Extract<Item, { kind: 'tool' }>[] = []
            for (let i = index; i < blocks.length; i++) {
              const next = blocks[i]
              if (!browserTool(next) || next?.kind !== 'item' || next.item.kind !== 'tool') break
              run.push(next.item)
            }
            return (
              <BrowserToolCard
                key={block.item.id}
                tools={run}
                hostKey={hostKey ?? changes?.hostKey}
              />
            )
          }
          const plainTool = (b: (typeof blocks)[number] | undefined) =>
            b?.kind === 'item' &&
            b.item.kind === 'tool' &&
            !isAgentTool(b.item) &&
            !isBrowserTool(b.item)
          if (plainTool(blocks[index - 1])) return null
          const tools: Extract<Item, { kind: 'tool' }>[] = []
          for (let i = index; i < blocks.length; i++) {
            const next = blocks[i]
            if (!plainTool(next) || next?.kind !== 'item' || next.item.kind !== 'tool') break
            tools.push(next.item)
          }
          const stopTurn = [...forkAnchor].find(
            ([, at]) => at >= index && at < index + tools.length,
          )?.[0]
          const group = <ToolGroup key={block.item.id} tools={tools} />
          return forkable(stopTurn, index + tools.length - 1) ? (
            <div key={block.item.id} className="has-fork">
              {group}
              {forkButton(stopTurn!)}
            </div>
          ) : (
            group
          )
        }
        const turnNo = block.item.kind === 'message' ? block.item.turnNo : undefined
        const canFork = forkable(turnNo, index)
        return (
          <div key={block.item.id} className={canFork ? 'has-fork' : undefined}>
            <ItemView
              item={block.item}
              cwd={cwd}
              hostKey={hostKey ?? changes?.hostKey}
              onApprove={onApprove}
              onAnswer={onAnswer}
              live={live && block.item === items.at(-1)}
            />
            {canFork && forkButton(turnNo!)}
            {turnNo !== undefined &&
              forkAnchor.get(turnNo) === index &&
              turnDurations?.[turnNo] !== undefined && (
                <div className="turn-duration">{elapsedLabel(turnDurations[turnNo]!)}</div>
              )}
          </div>
        )
      })}
    </>
  )
})

const FOLD_LINES = 8

/** A long message of yours starts folded to a few lines; a quiet button on hover opens it. */
function UserText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24
      setLong(el.scrollHeight > lineHeight * FOLD_LINES + 2)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  return (
    <>
      <div ref={ref} className={`plain user-text ${long && !expanded ? 'folded' : ''}`}>
        {text}
      </div>
      {long && (
        <button
          type="button"
          className="user-fold-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp size={12} /> Show less
            </>
          ) : (
            <>
              <ChevronDown size={12} /> Show more
            </>
          )}
        </button>
      )}
    </>
  )
}

function ItemView({
  item,
  cwd,
  hostKey,
  onApprove,
  onAnswer,
  live,
}: {
  item: Item
  cwd: string
  hostKey?: string
  onApprove(requestId: string, optionId: string): void | Promise<void>
  onAnswer?(requestId: string, answers?: Record<string, string[]>): void | Promise<void>
  live?: boolean
}) {
  switch (item.kind) {
    case 'message':
      return item.role === 'user' ? (
        <div className="msg user" data-msg-id={item.id}>
          {item.attachments && item.attachments.length > 0 && (
            <div className="chips">
              {item.attachments.map((a) =>
                hostKey && isImageName(a.name) ? (
                  <AttachmentImage key={a.path} hostKey={hostKey} name={a.name} path={a.path} />
                ) : (
                  <span key={a.path} className="chip static">
                    <Paperclip size={12} /> {a.name}
                  </span>
                ),
              )}
            </div>
          )}
          {item.text && <UserText text={item.text} />}
        </div>
      ) : (
        <Markdown text={item.text} live={live} />
      )
    case 'tool':
      return <ToolGroup tools={[item]} />
    case 'approval':
      return <ApprovalCard item={item} cwd={cwd} onApprove={onApprove} />
    case 'question':
      return onAnswer ? <QuestionCard item={item} onAnswer={onAnswer} /> : null
    case 'error':
      return <div className="msg error">{item.message}</div>
    case 'compaction':
      return <CompactionRow item={item} />
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

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))

/** A line across the thread where the agent shrank its conversation to make room. */
function CompactionRow({ item }: { item: Extract<Item, { kind: 'compaction' }> }) {
  const running = item.state === 'running'
  const sizes =
    item.tokensBefore !== undefined && item.tokensAfter !== undefined
      ? ` · ${tokens(item.tokensBefore)} → ${tokens(item.tokensAfter)} tokens`
      : item.tokensBefore !== undefined
        ? ` · was ${tokens(item.tokensBefore)} tokens`
        : ''
  const label = running
    ? 'Compacting conversation…'
    : item.state === 'failed'
      ? 'Could not compact the conversation'
      : `${item.trigger === 'auto' ? 'Conversation compacted automatically' : 'Conversation compacted'}${sizes}`
  return (
    <div
      className={`compaction ${item.state}`}
      role="status"
      aria-live="polite"
      title={running ? 'Summarizing earlier messages to free up context' : undefined}
    >
      {running ? (
        <LoaderCircle size={13} className="compaction-spin" />
      ) : (
        <FoldVertical size={13} />
      )}
      <span>{label}</span>
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
      {open && <PatchView patch={file.patch} limit={INLINE_PATCH_LINES} />}
    </div>
  )
}
