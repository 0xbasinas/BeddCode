import {
  agentDisplayName,
  agentToolView,
  CHILD_PHASE_LABEL,
  formatDuration,
  preview,
  toolDuration,
  type ChildPhase,
  type SessionView,
  type Tool,
} from '@beddcode/client-runtime'
import { router } from 'expo-router'
import {
  ArrowUpRight,
  CaretDown,
  CaretRight,
  Check,
  ArrowBendLeftUp,
  Hand,
  Prohibit,
  X,
} from 'phosphor-react-native'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'

import { useHostStore } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Icon } from '@/ui/Icon'
import { Faint, Text } from '@/ui/Text'

const NO_SESSIONS: Record<string, SessionView> = {}
const LIVE: ChildPhase[] = ['starting', 'running', 'needs-you']

function useHostSessions(hostKey: string | undefined) {
  return useHostStore((s) =>
    hostKey ? (s.runtimes[hostKey]?.replica.sessions ?? NO_SESSIONS) : NO_SESSIONS,
  )
}

function useLabels(hostKey: string | undefined) {
  const providers = useHostStore((s) => (hostKey ? s.runtimes[hostKey]?.providers : undefined))
  const labels: Record<string, string> = {}
  for (const p of providers ?? []) labels[p.id] = p.label
  return labels
}

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

const PHASE_COLOR: Record<ChildPhase, string> = {
  starting: colors.accent,
  running: colors.accent,
  'needs-you': colors.accent,
  done: colors.success,
  failed: colors.danger,
  stopped: colors.faint,
}

function Phase({ phase, elapsed }: { phase: ChildPhase; elapsed?: number }) {
  const color = PHASE_COLOR[phase]
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      {phase === 'starting' || phase === 'running' ? (
        <ActivityIndicator
          size="small"
          color={color}
          style={{ transform: [{ scale: 0.5 }], margin: -6 }}
        />
      ) : (
        <Icon
          icon={
            phase === 'needs-you'
              ? Hand
              : phase === 'done'
                ? Check
                : phase === 'failed'
                  ? X
                  : Prohibit
          }
          size={11}
          color={color}
        />
      )}
      <Text size={11} color={color}>
        {CHILD_PHASE_LABEL[phase]}
        {elapsed !== undefined ? ` · ${formatDuration(elapsed)}` : ''}
      </Text>
    </View>
  )
}

function Avatar({ label }: { label: string }) {
  return (
    <View style={styles.avatar}>
      <Text size={9} weight="semibold" color={colors.text}>
        {label.slice(0, 2).toUpperCase()}
      </Text>
    </View>
  )
}

function open(id: string) {
  router.push({ pathname: '/session/[id]', params: { id } })
}

/** One call to BeddCode's agent tools: who was started or asked, how it is doing, and a way in. */
export function AgentToolCard({
  tool,
  parentId,
  hostKey,
}: {
  tool: Tool
  parentId: string
  hostKey?: string
}) {
  const sessions = useHostSessions(hostKey)
  const labels = useLabels(hostKey)
  const view = agentToolView(tool, { parentId, sessions })
  const live =
    tool.status === 'running' || (view?.child !== undefined && LIVE.includes(view.child.phase))
  const now = useNow(live)
  const [folded, setFolded] = useState(true)
  if (!view) return null
  const child = view.child
  const name = agentDisplayName(child?.agent, labels)
  const card =
    view.name === 'start_session' || view.name === 'wait_for' || view.name === 'read_transcript'
  const phase: ChildPhase | undefined = view.error ? 'failed' : child?.phase
  const elapsed =
    view.name === 'start_session' && child?.startedAt !== undefined
      ? Math.max(0, (child.endedAt ?? now) - child.startedAt)
      : toolDuration(tool, now)
  const body =
    view.name === 'start_session'
      ? child && !LIVE.includes(child.phase)
        ? child.reply
        : undefined
      : view.name === 'wait_for'
        ? view.reply
        : view.transcript
  const what =
    view.name === 'list_agents'
      ? view.listed?.map((l) => l.label).join(', ')
      : view.name === 'list_children'
        ? `${view.listed?.length ?? 0} sessions`
        : undefined

  if (!card) {
    return (
      <Pressable
        style={styles.row}
        disabled={!child?.id || !child.known}
        onPress={() => child?.id && open(child.id)}
      >
        <Text size={12.5} color={colors.faint} numberOfLines={1} style={{ flex: 1 }}>
          {view.verb}
          {child ? (
            <Text size={12.5} weight="semibold" color={colors.text}>{` ${name}`}</Text>
          ) : null}
          {child?.title ? (
            <Text size={12.5} color={colors.textSecondary}>{` · ${child.title}`}</Text>
          ) : null}
          {view.prompt ? (
            <Text size={12.5} color={colors.muted}>{` “${preview(view.prompt, 80)}”`}</Text>
          ) : null}
          {what ? <Text size={12.5} color={colors.muted}>{` ${what}`}</Text> : null}
        </Text>
        {view.pending ? (
          <ActivityIndicator
            size="small"
            color={colors.muted}
            style={{ transform: [{ scale: 0.6 }] }}
          />
        ) : (
          <Icon
            icon={view.error ? X : Check}
            size={13}
            color={view.error ? colors.danger : colors.success}
          />
        )}
      </Pressable>
    )
  }

  return (
    <View
      style={[
        styles.card,
        phase && LIVE.includes(phase) ? { borderColor: colors.accentSoft } : null,
      ]}
    >
      <View style={styles.head}>
        <Avatar label={name} />
        <Text size={13} color={colors.faint} numberOfLines={1} style={{ flex: 1 }}>
          {view.verb}{' '}
          <Text size={13} weight="semibold" color={colors.text}>
            {name}
          </Text>
          {child?.title ? (
            <Text size={13} color={colors.textSecondary}>{` · ${child.title}`}</Text>
          ) : null}
        </Text>
        {phase ? <Phase phase={phase} elapsed={elapsed} /> : null}
      </View>
      {view.prompt ? (
        <Text size={12.5} color={colors.textSecondary} numberOfLines={2} style={styles.indent}>
          {view.prompt}
        </Text>
      ) : null}
      {child?.folder ? (
        <Faint size={11.5} numberOfLines={1} style={styles.indent}>
          {child.worktree ? 'Worktree' : 'Folder'} · {child.folder.split(/[\\/]/).pop()}
          {child.branch ? ` · ${child.branch}` : ''}
        </Faint>
      ) : null}
      {child?.activity && LIVE.includes(child.phase) ? (
        <Text size={11.5} mono color={colors.muted} numberOfLines={1} style={styles.indent}>
          ● {child.activity}
        </Text>
      ) : null}
      {view.error ? (
        <Text size={12} color={colors.danger} style={styles.indent}>
          {view.error}
        </Text>
      ) : null}
      {body ? (
        <Pressable style={styles.fold} onPress={() => setFolded((f) => !f)}>
          <Icon icon={folded ? CaretRight : CaretDown} size={11} color={colors.faint} />
          <Text
            size={12}
            color={colors.textSecondary}
            numberOfLines={folded ? 1 : 30}
            style={{ flex: 1 }}
            selectable={!folded}
          >
            <Text size={12} color={colors.faint}>
              {view.name === 'read_transcript'
                ? 'Conversation '
                : view.name === 'wait_for'
                  ? 'Reply '
                  : 'Result '}
            </Text>
            {folded ? preview(body, 120) : body}
          </Text>
        </Pressable>
      ) : null}
      {child?.id && child.known ? (
        <Pressable style={styles.openBtn} onPress={() => open(child.id!)} hitSlop={6}>
          <Text size={12} color={colors.accent}>
            Open session
          </Text>
          <Icon icon={ArrowUpRight} size={12} color={colors.accent} />
        </Pressable>
      ) : null}
    </View>
  )
}

/** At the top of a session another session's agent started: who, and a way back. */
export function StartedByBanner({ session, hostKey }: { session: SessionView; hostKey?: string }) {
  const sessions = useHostSessions(hostKey)
  const labels = useLabels(hostKey)
  if (!session.parent) return null
  const parent = sessions[session.parent.sessionId]
  const label = agentDisplayName(parent?.instanceId, labels)
  return (
    <Pressable
      style={styles.banner}
      disabled={!parent}
      onPress={() => parent && open(parent.id)}
      accessibilityRole="link"
    >
      <Icon icon={ArrowBendLeftUp} size={14} color={colors.accent} />
      <Text size={12.5} color={colors.muted} numberOfLines={2} style={{ flex: 1 }}>
        Started by{' '}
        {parent ? (
          <>
            <Text size={12.5} weight="semibold" color={colors.text}>
              {label}
            </Text>{' '}
            in{' '}
            <Text size={12.5} color={colors.text}>
              {parent.title}
            </Text>
          </>
        ) : (
          'another session'
        )}
      </Text>
      {parent ? (
        <Text size={12} color={colors.accent}>
          Open
        </Text>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    padding: 11,
    gap: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  indent: { marginLeft: 28 },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 5,
    backgroundColor: colors.active,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  fold: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginLeft: 24,
    paddingVertical: 2,
  },
  openBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
    backgroundColor: colors.card,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 8,
  },
})
