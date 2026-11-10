import {
  agentLabel,
  isAgentTool,
  buildBlocks,
  createBlockBuilder,
  defaultOpen,
  formatDuration,
  parseHandoffNote,
  summarizeTools,
  toolDetails,
  toolDuration,
  toolLabel,
  toolPhase,
  totalChanges,
  type EditedFile,
  type SessionView,
  type Tool,
  type TranscriptItem,
} from '@beddcode/client-runtime'
import {
  Prohibit,
  ArrowUUpLeft,
  Check,
  CaretDown,
  CaretRight,
  ArrowsLeftRight,
  FileText,
  FolderOpen,
  Hand,
  MagnifyingGlass,
  PencilSimpleLine,
  TerminalWindow,
  Wrench,
  X,
} from 'phosphor-react-native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Animated, FlatList, Pressable, StyleSheet, View } from 'react-native'

import { colors, radius } from '@/theme/tokens'
import { AttachmentImage, isImageName } from '@/features/composer/AttachmentImage'
import { debugThisPrompt } from '@/features/composer/contextMentions'
import { useComposerPrefill } from '@/host/composerPrefill'
import { hostRequest, undoTurn, useHostStore } from '@/host/store'
import { Message } from './Message'
import { Diffstat } from '@/ui/Diffstat'
import { FadeIn } from '@/ui/FadeIn'
import { animateLayout } from '@/ui/layoutAnimation'
import { PatchView } from '@/ui/PatchView'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { AgentToolCard } from './AgentToolCard'

type Entry =
  | { kind: 'item'; id: string; item: TranscriptItem }
  | { kind: 'tools'; id: string; tools: Tool[] }
  | { kind: 'agent-tool'; id: string; tool: Tool }
  | { kind: 'edits'; id: string; files: EditedFile[] }

/** Runs of consecutive tool calls read as one group, like the desktop transcript. */
function entries(items: TranscriptItem[], build = buildBlocks): Entry[] {
  const out: Entry[] = []
  for (const block of build(items)) {
    if (block.kind === 'edits') {
      out.push({ kind: 'edits', id: block.id, files: block.files })
    } else if (block.item.kind === 'tool' && isAgentTool(block.item)) {
      // Starting and managing other agents gets a card of its own (see AgentToolCard).
      out.push({ kind: 'agent-tool', id: block.item.id, tool: block.item })
    } else if (block.item.kind === 'tool') {
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.tools.push(block.item)
      else out.push({ kind: 'tools', id: `tools-${block.item.id}`, tools: [block.item] })
    } else {
      out.push({ kind: 'item', id: block.item.id, item: block.item })
    }
  }
  return out
}

const TOOL_ICONS = {
  command: TerminalWindow,
  read: FileText,
  edit: PencilSimpleLine,
  search: MagnifyingGlass,
  other: Wrench,
} as const

/** Re-renders every second while a tool runs, so its duration ticks. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function ToolRow({ tool, now }: { tool: Tool; now: number }) {
  const [open, setOpen] = useState(false)
  const label = toolLabel(tool)
  const phase = toolPhase(tool)
  const duration = toolDuration(tool, now)
  const failed = phase === 'failed'
  return (
    <View>
      <Pressable
        style={styles.toolRow}
        onPress={() => {
          animateLayout()
          setOpen((v) => !v)
        }}
      >
        <Icon icon={TOOL_ICONS[tool.toolKind]} size={15} color={colors.faint} />
        <Text
          size={12.5}
          color={failed ? colors.danger : colors.faint}
          numberOfLines={1}
          style={{ flex: 1 }}
        >
          {label.verb ? `${label.verb} ` : ''}
          <Text size={12.5} mono color={failed ? colors.danger : colors.textSecondary}>
            {label.prompt ? `${label.prompt} ` : ''}
            {label.target}
          </Text>
        </Text>
        {duration !== undefined && phase !== 'running' ? (
          <Faint size={11.5}>{formatDuration(duration)}</Faint>
        ) : null}
        <PhaseIcon phase={phase} />
      </Pressable>
      {open ? (
        <View style={styles.toolDetails}>
          {toolDetails(tool, now).map((d, i) => (
            <View key={i} style={{ gap: 2 }}>
              <Faint size={11}>{d.label}</Faint>
              <Text size={12} mono={d.mono} color={colors.textSecondary} selectable>
                {d.value}
              </Text>
            </View>
          ))}
          {tool.output?.trim() ? (
            <Text size={11.5} mono color={colors.muted} selectable numberOfLines={24}>
              {tool.output.trim()}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function PhaseIcon({ phase }: { phase: ReturnType<typeof toolPhase> }) {
  switch (phase) {
    case 'awaiting-approval':
      return <Icon icon={Hand} size={13} color={colors.accent} />
    case 'running':
    case 'approved':
      return (
        <ActivityIndicator
          size="small"
          color={colors.muted}
          style={{ transform: [{ scale: 0.6 }] }}
        />
      )
    case 'ok':
      return <Icon icon={Check} size={13} color={colors.faint} />
    case 'failed':
    case 'denied':
      return <Icon icon={X} size={13} color={colors.danger} />
    case 'cancelled':
      return <Icon icon={Prohibit} size={13} color={colors.faint} />
  }
}

function ToolGroup({ tools }: { tools: Tool[] }) {
  const running = tools.some((t) => t.status === 'running')
  const now = useNow(running)
  const [open, setOpen] = useState(defaultOpen(tools))
  return (
    <View style={{ gap: 2 }}>
      {tools.length > 3 ? (
        <Pressable
          style={styles.summary}
          onPress={() => {
            animateLayout()
            setOpen((v) => !v)
          }}
        >
          <Icon icon={open ? CaretDown : CaretRight} size={12} color={colors.faint} />
          <Faint size={12.5}>{summarizeTools(tools)}</Faint>
        </Pressable>
      ) : null}
      {open || tools.length <= 3
        ? tools.map((t) => <ToolRow key={t.id} tool={t} now={now} />)
        : null}
    </View>
  )
}

/** A path relative to the session's folder, so it reads like the project and not like a drive. */
function relativePath(path: string, cwd: string): string {
  const p = path.replaceAll('\\', '/')
  const root = cwd.replaceAll('\\', '/').replace(/\/$/, '')
  return p.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? p.slice(root.length + 1)
    : p.split('/').slice(-3).join('/')
}

function EditsCard({ files, cwd }: { files: EditedFile[]; cwd: string }) {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<string>()
  const total = totalChanges(files)
  return (
    <View style={styles.card}>
      <Pressable
        style={styles.cardHead}
        onPress={() => {
          animateLayout()
          setOpen((v) => !v)
        }}
      >
        <Icon icon={PencilSimpleLine} size={18} />
        <View style={{ flex: 1 }}>
          <Text size={13.5}>
            Edited {files.length} file{files.length === 1 ? '' : 's'}
          </Text>
          <Diffstat added={total.added} removed={total.removed} />
        </View>
        <Icon icon={open ? CaretDown : CaretRight} size={15} />
      </Pressable>
      {open &&
        files.map((f) => (
          <View key={f.path} style={styles.fileBlock}>
            <Pressable
              style={styles.fileRow}
              onPress={() => {
                animateLayout()
                setExpanded(expanded === f.path ? undefined : f.path)
              }}
            >
              <Text size={13} numberOfLines={1} style={{ flex: 1 }}>
                {relativePath(f.path, cwd)}
              </Text>
              <Diffstat added={f.added} removed={f.removed} />
            </Pressable>
            {expanded === f.path ? <PatchView patch={f.patch} /> : null}
          </View>
        ))}
    </View>
  )
}

type ChangesItem = Extract<TranscriptItem, { kind: 'changes' }>

const STATUS_LABEL: Record<ChangesItem['files'][number]['status'], string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
}

/**
 * What a turn changed in the folder, from the host's before/after snapshots.
 * The latest turn of an idle session can be undone, and each file's diff can be opened.
 */
function ChangesCard({
  item,
  hostKey,
  sessionId,
  canUndo,
  onOpenFile,
}: {
  item: ChangesItem
  hostKey?: string
  sessionId: string
  canUndo: boolean
  onOpenFile?(path: string): void
}) {
  const [open, setOpen] = useState(item.files.length <= 3 && !item.reverted)
  const [confirming, setConfirming] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [error, setError] = useState<string>()
  const added = item.files.reduce((n, f) => n + f.added, 0)
  const removed = item.files.reduce((n, f) => n + f.removed, 0)
  const coverage = item.coverage ?? { state: item.truncated ? 'truncated' : 'full' }
  const unavailable = coverage.state === 'skipped' || coverage.state === 'expired'

  const undo = async () => {
    setUndoing(true)
    setError(undefined)
    try {
      await undoTurn(sessionId, item.after)
      setConfirming(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <View style={[styles.card, item.reverted ? { opacity: 0.7 } : null]}>
      <View style={styles.cardHead}>
        <Pressable
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}
          onPress={() => {
            animateLayout()
            setOpen((v) => !v)
          }}
        >
          <Icon icon={PencilSimpleLine} size={18} />
          <View style={{ flex: 1 }}>
            <Text size={13.5}>
              {item.reverted ? 'Undone: ' : ''}Changed {item.files.length} file
              {item.files.length === 1 ? '' : 's'}
              {item.truncated ? '+' : ''} this turn
            </Text>
            <Diffstat added={added} removed={removed} />
          </View>
          <Icon icon={open ? CaretDown : CaretRight} size={15} />
        </Pressable>
        {canUndo && !unavailable && !item.reverted && !confirming ? (
          <Pressable
            onPress={() => setConfirming(true)}
            accessibilityRole="button"
            accessibilityLabel="Undo these changes"
            style={{ paddingHorizontal: 6, paddingVertical: 4 }}
          >
            <Icon icon={ArrowUUpLeft} size={16} />
          </Pressable>
        ) : null}
      </View>
      {confirming ? (
        <View style={styles.fileBlock}>
          <Muted size={12.5} style={{ paddingHorizontal: 12, paddingTop: 8 }}>
            Put these files back the way they were before this turn? Staged changes and commits stay
            as they are.
          </Muted>
          <View style={{ flexDirection: 'row', gap: 12, padding: 12 }}>
            <Pressable onPress={() => void undo()} disabled={undoing} accessibilityRole="button">
              <Text size={13}>{undoing ? 'Undoing…' : 'Undo changes'}</Text>
            </Pressable>
            <Pressable onPress={() => setConfirming(false)} disabled={undoing}>
              <Muted size={13}>Keep</Muted>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error ? (
        <Text size={12} color={colors.danger} style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
          {error}
        </Text>
      ) : null}
      {open &&
        item.files.map((f) => (
          <ChangedFile
            key={f.path}
            file={f}
            hostKey={hostKey}
            sessionId={sessionId}
            after={item.after}
            onOpenFile={item.reverted || f.status === 'D' ? undefined : onOpenFile}
          />
        ))}
    </View>
  )
}

function ChangedFile({
  file,
  hostKey,
  sessionId,
  after,
  onOpenFile,
}: {
  file: ChangesItem['files'][number]
  hostKey?: string
  sessionId: string
  after: string
  onOpenFile?(path: string): void
}) {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<{ patch?: string; truncated?: boolean } | 'loading' | { error: string }>()
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && hostKey && (diff === undefined || (typeof diff === 'object' && 'error' in diff))) {
      setDiff('loading')
      hostRequest(hostKey, 'sessions.turnDiff', { sessionId, after, path: file.path }).then(
        setDiff,
        (err: unknown) => setDiff({ error: err instanceof Error ? err.message : String(err) }),
      )
    }
  }
  return (
    <View style={styles.fileBlock}>
      <View style={styles.fileRow}>
        <Pressable style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }} onPress={toggle}>
          <Text size={13} numberOfLines={1} style={{ flex: 1 }}>
            {file.oldPath ? `${file.oldPath} → ` : ''}
            {file.path}
          </Text>
          <Faint size={11}>{STATUS_LABEL[file.status]}</Faint>
          {file.binary ? (
            <Faint size={11.5}>binary</Faint>
          ) : (
            <Diffstat added={file.added} removed={file.removed} />
          )}
        </Pressable>
        {onOpenFile ? (
          <Pressable
            hitSlop={8}
            onPress={() => onOpenFile(file.path)}
            accessibilityLabel={`Open ${file.path}`}
          >
            <Icon icon={FolderOpen} size={14} />
          </Pressable>
        ) : null}
      </View>
      {open ? (
        diff === 'loading' || diff === undefined ? (
          <Faint size={12} style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            Loading diff…
          </Faint>
        ) : 'error' in diff ? (
          <Text size={12} color={colors.danger} style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            {diff.error}
          </Text>
        ) : diff.patch ? (
          <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
            <PatchView patch={diff.patch} />
            {diff.truncated ? (
              <Faint size={11.5} style={{ paddingHorizontal: 8, paddingTop: 4 }}>
                Diff cut short
              </Faint>
            ) : null}
          </View>
        ) : (
          <Faint size={12} style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            {diff.truncated ? 'Binary file or too large to show' : 'No line changes'}
          </Faint>
        )
      ) : null}
    </View>
  )
}

/** How many rows are drawn at first; earlier ones are added as the reader scrolls up to them. */
const FIRST_ROWS = 6
// Adding older rows in steps after the thread opened re-laid the list out every few frames, which
// felt like lag inside the thread. It now draws the newest rows once and adds more only on scrolling up.
const OPENING_ROWS = FIRST_ROWS
const OPENING_STEP = 6
const OPENING_PAUSE_MS = 120
const MORE_ROWS = 12

/** Same row, same content: nothing to draw again (the entries are rebuilt on every event). */
function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false
  if (a.kind === 'item' && b.kind === 'item') return a.item === b.item
  if (a.kind === 'agent-tool' && b.kind === 'agent-tool') return a.tool === b.tool
  if (a.kind === 'tools' && b.kind === 'tools')
    return a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i])
  if (a.kind === 'edits' && b.kind === 'edits')
    return (
      a.files.length === b.files.length &&
      a.files.every((f, i) => {
        const g = b.files[i]!
        return (
          f.path === g.path && f.added === g.added && f.removed === g.removed && f.patch === g.patch
        )
      })
    )
  return false
}

interface RowProps {
  entry: Entry
  cwd: string
  sessionId: string
  hostKey?: string
  onApprove(requestId: string, optionId: string): Promise<void>
  onAnswer(requestId: string, answers?: Record<string, string[]>): Promise<void>
  onOpenFile?(path: string): void
  canUndo?: boolean
  onQuote?(text: string, turnNo?: number): void
  /** Appeared after the thread was first shown, so it eases in. */
  fresh: boolean
  /** The message still being written: its settled paragraphs are drawn once, only the end again. */
  live?: boolean
}

/** Rows that have already eased in, so scrolling back to one does not play it again. */
const played = new Set<string>()

const Row = memo(
  function Row({ entry, cwd, sessionId, hostKey, onApprove, onAnswer, onOpenFile, canUndo, onQuote, fresh, live }: RowProps) {
    const body = (() => {
      if (entry.kind === 'tools') return <ToolGroup tools={entry.tools} />
      if (entry.kind === 'agent-tool')
        return <AgentToolCard tool={entry.tool} parentId={sessionId} hostKey={hostKey} />
      if (entry.kind === 'edits') return <EditsCard files={entry.files} cwd={cwd} />
      const item = entry.item
      switch (item.kind) {
        case 'message':
          return item.role === 'user' ? (
            <Pressable
              style={styles.userBubble}
              onLongPress={onQuote ? () => onQuote(item.text, item.turnNo) : undefined}
              delayLongPress={350}
              accessibilityHint={onQuote ? 'Long press to quote' : undefined}
            >
              <Text size={14} color={colors.textSecondary} style={{ lineHeight: 21 }} selectable>
                {item.text}
              </Text>
              {item.attachments && item.attachments.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {item.attachments.map((a) =>
                    hostKey && isImageName(a.name) ? (
                      <AttachmentImage
                        key={a.path}
                        hostKey={hostKey}
                        name={a.name}
                        path={a.path}
                        size={72}
                      />
                    ) : (
                      <Faint key={a.path} size={11.5}>
                        📎 {a.name}
                      </Faint>
                    ),
                  )}
                </View>
              ) : null}
            </Pressable>
          ) : (
            <Pressable
              onLongPress={onQuote ? () => onQuote(item.text, item.turnNo) : undefined}
              delayLongPress={350}
              accessibilityHint={onQuote ? 'Long press to quote' : undefined}
            >
              <Message text={item.text} live={live} />
            </Pressable>
          )
        case 'approval':
          return <ApprovalCard item={item} cwd={cwd} onApprove={onApprove} />
        case 'question':
          return <QuestionCard item={item} onAnswer={onAnswer} />
        case 'switch':
          return <SwitchMarker item={item} hostKey={hostKey} />
        case 'notice':
          return (
            <Muted size={12.5} style={{ textAlign: 'center' }}>
              {item.message}
            </Muted>
          )
        case 'agent-message':
          return (
            <Muted size={12.5}>
              Agent message · {item.senderId} → {item.recipientId}
              {'\n'}Thread {item.threadId}
              {'\n'}
              {item.text}
            </Muted>
          )
        case 'changes':
          return (
            <ChangesCard
              item={item}
              hostKey={hostKey}
              sessionId={sessionId}
              canUndo={Boolean(canUndo)}
              onOpenFile={onOpenFile}
            />
          )
        case 'error':
          return (
            <View style={styles.errorBox}>
              <Text size={13} color={colors.danger} selectable>
                {item.message}
              </Text>
              {onQuote || sessionId ? (
                <Pressable
                  onPress={() =>
                    useComposerPrefill
                      .getState()
                      .set(sessionId, debugThisPrompt('error', item.message))
                  }
                  accessibilityRole="button"
                  style={{ paddingTop: 6 }}
                >
                  <Text size={12} color={colors.textSecondary}>
                    Debug this
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )
        default:
          return null
      }
    })()
    useEffect(() => {
      const key = `${sessionId}:${entry.id}`
      played.delete(key)
      played.add(key)
      if (played.size > 4000) played.delete(played.values().next().value!)
    }, [sessionId, entry.id])
    return <FadeIn enabled={fresh && !played.has(`${sessionId}:${entry.id}`)}>{body}</FadeIn>
  },
  (a, b) =>
    a.fresh === b.fresh &&
    a.live === b.live &&
    a.cwd === b.cwd &&
    a.sessionId === b.sessionId &&
    a.hostKey === b.hostKey &&
    a.onApprove === b.onApprove &&
    a.onAnswer === b.onAnswer &&
    a.onOpenFile === b.onOpenFile &&
    a.canUndo === b.canUndo &&
    a.onQuote === b.onQuote &&
    sameEntry(a.entry, b.entry),
)

/** The conversation: what you asked, what the agent said and did, and anything it waits on. */
export function Transcript({
  session,
  cwd,
  onApprove,
  onAnswer,
  onOpenFile,
  onQuote,
  header,
  footer,
  hostKey,
  onFirstLayout,
}: {
  session: SessionView
  cwd: string
  /** The session's host, so agent-tool cards can follow the sessions they start. */
  hostKey?: string
  onApprove(requestId: string, optionId: string): Promise<void>
  onAnswer(requestId: string, answers?: Record<string, string[]>): Promise<void>
  onOpenFile?(path: string): void
  onQuote?(text: string, turnNo?: number): void
  header?: React.ReactElement
  footer?: React.ReactElement
  /** Called once, when the first rows of the thread have been laid out. */
  onFirstLayout?(): void
}) {
  const build = useMemo(() => createBlockBuilder(), [session.id])
  const all = useMemo(() => entries(session.items, build), [session.items, build])
  const list = useRef<FlatList<Entry>>(null)
  const laidOut = useRef(false)
  // Tables and code blocks settle their size a moment after they are drawn; the list stays hidden
  // until then and eases in, rather than showing them jump.
  const reveal = useRef(new Animated.Value(0)).current
  const stick = useRef(true)
  // A long thread draws only its latest rows first, so it opens at once, at the bottom.
  const [shown, setShown] = useState(OPENING_ROWS)
  const [laid, setLaid] = useState(false)
  useEffect(() => {
    if (!laid || shown >= FIRST_ROWS) return
    const timer = setTimeout(
      () => setShown((n) => Math.min(n + OPENING_STEP, FIRST_ROWS)),
      OPENING_PAUSE_MS,
    )
    return () => clearTimeout(timer)
  }, [laid, shown])
  const hidden = Math.max(0, all.length - shown)
  const data = useMemo(() => (hidden ? all.slice(hidden) : all), [all, hidden])
  const showEarlier = useCallback(() => setShown((n) => n + MORE_ROWS), [])

  // The handlers come in as fresh closures on every render; rows see steady ones.
  const approveRef = useRef(onApprove)
  const answerRef = useRef(onAnswer)
  approveRef.current = onApprove
  answerRef.current = onAnswer
  const approve = useCallback((r: string, o: string) => approveRef.current(r, o), [])
  const answer = useCallback(
    (r: string, a?: Record<string, string[]>) => answerRef.current(r, a),
    [],
  )

  // Rows that turn up after the thread was first shown ease in; the rest are simply there.
  const seen = useRef<Set<string> | null>(null)
  const fresh = useRef<Set<string>>(new Set())
  useMemo(() => {
    if (seen.current && laidOut.current) {
      // Once fresh, a row stays marked so its wrapper never changes shape under it.
      for (const e of all) if (!seen.current.has(e.id)) fresh.current.add(e.id)
    }
    seen.current = new Set(all.map((e) => e.id))
  }, [all])

  const earlier =
    hidden > 0 ? (
      <Pressable style={styles.earlier} onPress={showEarlier}>
        <Faint size={12.5}>Show earlier ({hidden})</Faint>
      </Pressable>
    ) : null

  return (
    <Animated.View style={{ flex: 1, opacity: reveal }}>
      <FlatList
        ref={list}
        data={data}
        keyExtractor={(e) => e.id}
        ListHeaderComponent={
          <>
            {earlier}
            {hidden === 0 ? header : null}
          </>
        }
        ListFooterComponent={footer}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={OPENING_ROWS}
        windowSize={13}
        maxToRenderPerBatch={8}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onStartReached={hidden > 0 ? showEarlier : undefined}
        onStartReachedThreshold={0.6}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
          stick.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 120
        }}
        scrollEventThrottle={64}
        onContentSizeChange={(_width, height) => {
          if (!laidOut.current && height > 0) {
            laidOut.current = true
            Animated.timing(reveal, {
              toValue: 1,
              duration: 140,
              delay: 90,
              useNativeDriver: true,
            }).start()
            onFirstLayout?.()
            // Older rows then go in above the visible ones; the list keeps its place and stays at the end.
            setLaid(true)
          }
          // Offsets past the end are clamped, so this lands on the last row even before it is measured.
          if (stick.current) list.current?.scrollToOffset({ offset: height, animated: false })
        }}
        renderItem={({ item: entry }) => (
          <Row
            entry={entry}
            cwd={cwd}
            sessionId={session.id}
            hostKey={hostKey}
            onApprove={approve}
            onAnswer={answer}
            onOpenFile={onOpenFile}
            onQuote={onQuote}
            canUndo={
              entry.kind === 'item' &&
              entry.item.kind === 'changes' &&
              entry.item.id === session.items.filter((i) => i.kind === 'changes').at(-1)?.id &&
              session.status !== 'running'
            }
            fresh={fresh.current.has(entry.id)}
            live={session.status === 'running' && entry.id === all[all.length - 1]?.id}
          />
        )}
      />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingVertical: 14, gap: 14 },
  userBubble: {
    backgroundColor: colors.raised,
    borderRadius: radius.panel,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  toolDetails: { marginLeft: 23, gap: 8, paddingVertical: 6 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    overflow: 'hidden',
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  fileBlock: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  earlier: { alignItems: 'center', paddingVertical: 8 },
  errorBox: {
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.control,
    padding: 10,
  },
  switchMarker: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switchContent: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: 10,
    paddingTop: 10,
    gap: 10,
  },
})

function SwitchMarker({
  item,
  hostKey,
}: {
  item: {
    from: string
    to: string
    handoff: string
    permissionLabel?: string
    permissionNote?: string
  }
  hostKey?: string
}) {
  const [open, setOpen] = useState(false)
  const providers = useHostStore((s) => (hostKey ? s.runtimes[hostKey]?.providers : undefined))
  return (
    <View style={styles.switchMarker}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.switchRow}
      >
        <Icon icon={ArrowsLeftRight} size={14} color={colors.faint} />
        <Muted size={12.5} style={{ flex: 1 }}>
          Switched from {agentLabel(providers, item.from)} to {agentLabel(providers, item.to)}
        </Muted>
        <Icon icon={open ? CaretDown : CaretRight} size={14} color={colors.faint} />
      </Pressable>
      {open && (
        <View style={styles.switchContent}>
          {item.permissionNote || item.permissionLabel ? (
            <Muted size={12}>{item.permissionNote ?? `Permissions: ${item.permissionLabel}`}</Muted>
          ) : null}
          {parseHandoffNote(item.handoff).map((part, i) => (
            <View key={i}>
              {part.title ? (
                <Muted size={12} style={{ fontWeight: '600' }}>
                  {part.title}
                </Muted>
              ) : null}
              <Text size={12} color={colors.textSecondary} selectable>
                {part.body}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
