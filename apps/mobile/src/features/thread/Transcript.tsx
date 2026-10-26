import {
  isAgentTool,
  buildBlocks,
  defaultOpen,
  formatDuration,
  summarizeTools,
  toolDetails,
  toolDuration,
  toolLabel,
  toolPhase,
  splitStreamingMarkdown,
  totalChanges,
  type EditedFile,
  type SessionView,
  type Tool,
  type TranscriptItem,
} from '@beddcode/client-runtime'
import {
  Prohibit,
  Check,
  CaretDown,
  CaretRight,
  FileText,
  Hand,
  MagnifyingGlass,
  PencilSimpleLine,
  TerminalWindow,
  Wrench,
  X,
} from 'phosphor-react-native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, View } from 'react-native'
import Markdown from '@ronradtke/react-native-markdown-display'

import { colors, fonts, radius } from '@/theme/tokens'
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
function entries(items: TranscriptItem[]): Entry[] {
  const out: Entry[] = []
  for (const block of buildBlocks(items)) {
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

const markdownStyles = {
  body: { color: colors.text, fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: 10 },
  code_inline: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    backgroundColor: colors.hover,
    color: colors.text,
    borderWidth: 0,
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 0,
  },
  code_block: {
    fontFamily: fonts.mono,
    fontSize: 12,
    backgroundColor: colors.code,
    color: colors.textSecondary,
    borderColor: colors.borderSubtle,
    borderRadius: radius.control,
    padding: 10,
  },
  fence: {
    fontFamily: fonts.mono,
    fontSize: 12,
    backgroundColor: colors.code,
    color: colors.textSecondary,
    borderColor: colors.borderSubtle,
    borderRadius: radius.control,
    padding: 10,
  },
  link: { color: colors.info },
  heading1: { fontFamily: fonts.semibold, fontSize: 18, color: colors.text, marginBottom: 8 },
  heading2: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, marginBottom: 6 },
  heading3: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, marginBottom: 4 },
  bullet_list: { marginBottom: 6 },
  ordered_list: { marginBottom: 6 },
  blockquote: {
    backgroundColor: 'transparent',
    borderLeftColor: colors.border,
    borderLeftWidth: 3,
    paddingHorizontal: 10,
  },
  hr: { backgroundColor: colors.border },
  table: { borderColor: colors.border },
  th: { borderColor: colors.border },
  td: { borderColor: colors.border },
} as const

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

/** What a turn changed in the folder, from the host's before/after snapshots. Undo lives on desktop. */
function ChangesCard({ item }: { item: ChangesItem }) {
  const [open, setOpen] = useState(item.files.length <= 3 && !item.reverted)
  const added = item.files.reduce((n, f) => n + f.added, 0)
  const removed = item.files.reduce((n, f) => n + f.removed, 0)
  return (
    <View style={[styles.card, item.reverted ? { opacity: 0.7 } : null]}>
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
            {item.reverted ? 'Undone: ' : ''}Changed {item.files.length} file
            {item.files.length === 1 ? '' : 's'}
            {item.truncated ? '+' : ''} this turn
          </Text>
          <Diffstat added={added} removed={removed} />
        </View>
        <Icon icon={open ? CaretDown : CaretRight} size={15} />
      </Pressable>
      {open &&
        item.files.map((f) => (
          <View key={f.path} style={styles.fileBlock}>
            <View style={styles.fileRow}>
              <Text size={13} numberOfLines={1} style={{ flex: 1 }}>
                {f.path}
              </Text>
              {f.binary ? (
                <Faint size={11.5}>binary</Faint>
              ) : (
                <Diffstat added={f.added} removed={f.removed} />
              )}
            </View>
          </View>
        ))}
    </View>
  )
}

/** How many rows are drawn at first; earlier ones are added as the reader scrolls up to them. */
const FIRST_ROWS = 40
const MORE_ROWS = 40

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
  /** Appeared after the thread was first shown, so it eases in. */
  fresh: boolean
  /** The message still being written: its settled paragraphs are drawn once, only the end again. */
  live?: boolean
}

const StreamingText = memo(function StreamingText({ text }: { text: string }) {
  const [head, tail] = splitStreamingMarkdown(text)
  return (
    <>
      {head ? <SettledMarkdown>{head}</SettledMarkdown> : null}
      <Markdown style={markdownStyles}>{tail}</Markdown>
    </>
  )
})

const SettledMarkdown = memo(function SettledMarkdown({ children }: { children: string }) {
  return <Markdown style={markdownStyles}>{children}</Markdown>
})

/** Rows that have already eased in, so scrolling back to one does not play it again. */
const played = new Set<string>()

const Row = memo(
  function Row({ entry, cwd, sessionId, hostKey, onApprove, onAnswer, fresh, live }: RowProps) {
    const body = (() => {
      if (entry.kind === 'tools') return <ToolGroup tools={entry.tools} />
      if (entry.kind === 'agent-tool')
        return <AgentToolCard tool={entry.tool} parentId={sessionId} hostKey={hostKey} />
      if (entry.kind === 'edits') return <EditsCard files={entry.files} cwd={cwd} />
      const item = entry.item
      switch (item.kind) {
        case 'message':
          return item.role === 'user' ? (
            <View style={styles.userBubble}>
              <Text size={14} color={colors.textSecondary} style={{ lineHeight: 21 }} selectable>
                {item.text}
              </Text>
              {item.attachments?.map((a) => (
                <Faint key={a.path} size={11.5}>
                  📎 {a.name}
                </Faint>
              ))}
            </View>
          ) : live ? (
            <StreamingText text={item.text} />
          ) : (
            <Markdown style={markdownStyles}>{item.text}</Markdown>
          )
        case 'approval':
          return <ApprovalCard item={item} cwd={cwd} onApprove={onApprove} />
        case 'question':
          return <QuestionCard item={item} onAnswer={onAnswer} />
        case 'notice':
          return (
            <Muted size={12.5} style={{ textAlign: 'center' }}>
              {item.message}
            </Muted>
          )
        case 'changes':
          return <ChangesCard item={item} />
        case 'error':
          return (
            <View style={styles.errorBox}>
              <Text size={13} color={colors.danger} selectable>
                {item.message}
              </Text>
            </View>
          )
        default:
          return null
      }
    })()
    useEffect(() => {
      played.add(`${sessionId}:${entry.id}`)
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
    sameEntry(a.entry, b.entry),
)

/** The conversation: what you asked, what the agent said and did, and anything it waits on. */
export function Transcript({
  session,
  cwd,
  onApprove,
  onAnswer,
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
  header?: React.ReactElement
  footer?: React.ReactElement
  /** Called once, when the first rows of the thread have been laid out. */
  onFirstLayout?(): void
}) {
  const all = useMemo(() => entries(session.items), [session.items])
  const list = useRef<FlatList<Entry>>(null)
  const laidOut = useRef(false)
  const stick = useRef(true)
  // A long thread draws only its latest rows first, so it opens at once, at the bottom.
  const [shown, setShown] = useState(FIRST_ROWS)
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
      initialNumToRender={14}
      windowSize={9}
      maxToRenderPerBatch={8}
      removeClippedSubviews={Platform.OS === 'android'}
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
          onFirstLayout?.()
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
          fresh={fresh.current.has(entry.id)}
          live={session.status === 'running' && entry.id === all[all.length - 1]?.id}
        />
      )}
    />
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
    borderColor: '#4a2523',
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.control,
    padding: 10,
  },
})
