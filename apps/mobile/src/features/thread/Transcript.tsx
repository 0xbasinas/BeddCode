import {
  buildBlocks,
  defaultOpen,
  formatDuration,
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
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native'
import Markdown from '@ronradtke/react-native-markdown-display'

import { colors, fonts, radius } from '@/theme/tokens'
import { Diffstat } from '@/ui/Diffstat'
import { PatchView } from '@/ui/PatchView'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'

type Entry =
  | { kind: 'item'; id: string; item: TranscriptItem }
  | { kind: 'tools'; id: string; tools: Tool[] }
  | { kind: 'edits'; id: string; files: EditedFile[] }

/** Runs of consecutive tool calls read as one group, like the desktop transcript. */
function entries(items: TranscriptItem[]): Entry[] {
  const out: Entry[] = []
  for (const block of buildBlocks(items)) {
    if (block.kind === 'edits') {
      out.push({ kind: 'edits', id: block.id, files: block.files })
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
      <Pressable style={styles.toolRow} onPress={() => setOpen((v) => !v)}>
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
        <Pressable style={styles.summary} onPress={() => setOpen((v) => !v)}>
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
      <Pressable style={styles.cardHead} onPress={() => setOpen((v) => !v)}>
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
              onPress={() => setExpanded(expanded === f.path ? undefined : f.path)}
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
      <Pressable style={styles.cardHead} onPress={() => setOpen((v) => !v)}>
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

/** The conversation: what you asked, what the agent said and did, and anything it waits on. */
export function Transcript({
  session,
  cwd,
  onApprove,
  onAnswer,
  header,
  footer,
}: {
  session: SessionView
  cwd: string
  onApprove(requestId: string, optionId: string): Promise<void>
  onAnswer(requestId: string, answers?: Record<string, string[]>): Promise<void>
  header?: React.ReactElement
  footer?: React.ReactElement
}) {
  const data = useMemo(() => entries(session.items), [session.items])
  const list = useRef<FlatList<Entry>>(null)
  const stick = useRef(true)

  return (
    <FlatList
      ref={list}
      data={data}
      keyExtractor={(e) => e.id}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      contentContainerStyle={styles.list}
      keyboardShouldPersistTaps="handled"
      onScroll={(e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
        stick.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 120
      }}
      scrollEventThrottle={64}
      onContentSizeChange={(_width, height) => {
        // Offsets past the end are clamped, so this lands on the last row even before it is measured.
        if (stick.current) list.current?.scrollToOffset({ offset: height, animated: false })
      }}
      renderItem={({ item: entry }) => {
        if (entry.kind === 'tools') return <ToolGroup tools={entry.tools} />
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
      }}
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
  errorBox: {
    borderWidth: 1,
    borderColor: '#4a2523',
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.control,
    padding: 10,
  },
})
