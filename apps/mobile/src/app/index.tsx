import {
  activityLine,
  doneMenuAction,
  doneOpen,
  folderName,
  isFiledAway,
  sessionNote,
  nestSessions,
  splitDone,
  timeAgo,
  type SessionView,
} from '@beddcode/client-runtime'
import { router } from 'expo-router'
import {
  CaretDown,
  CaretRight,
  Checks,
  ClockCounterClockwise,
  FolderSimple,
  FolderSimplePlus,
  Gear,
  GitBranch,
  MagnifyingGlass,
  Monitor,
  NotePencil,
  Plus,
  SortDescending,
  Trash,
  ArrowUUpLeft,
  X,
} from 'phosphor-react-native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native'

import { deleteSession, setSessionDone, useAllSessions, useHostStore } from '@/host/store'
import { usePrefs } from '@/host/prefs'
import { colors, fonts, radius } from '@/theme/tokens'
import { Diffstat } from '@/ui/Diffstat'
import { FadeIn } from '@/ui/FadeIn'
import { animateLayout } from '@/ui/layoutAnimation'
import { useWhileFocused } from '@/ui/useWhileFocused'
import { PressableScale } from '@/ui/PressableScale'
import { Icon } from '@/ui/Icon'
import { Logo } from '@/ui/Logo'
import { MenuSheet, type MenuItem } from '@/ui/MenuSheet'
import { Screen } from '@/ui/Screen'
import { StatusDot } from '@/ui/StatusDot'
import { Faint, Muted, Text } from '@/ui/Text'
import { Button } from '@/ui/Button'

type Filter = 'all' | 'needs-you' | 'done'

const PRIORITY: Record<SessionView['status'], number> = {
  'needs-you': 0,
  failed: 1,
  running: 2,
  idle: 3,
}

type Row =
  | {
      kind: 'folder'
      key: string
      name: string
      host: string
      collapsed: boolean
      hostKey: string
      /** The project folder on its host; empty for sessions without a project. */
      path: string
    }
  | { kind: 'session'; key: string; session: SessionView; hostKey: string; depth?: number }
  | { kind: 'done'; key: string; count: number; open: boolean; groupKey: string }

/** The sessions of every paired host: the desktop sidebar, as a full screen. */
export default function SessionsScreen() {
  const entries = useHostStore((s) => s.entries)
  // While a thread is open on top, this list keeps what it last drew instead of redoing its
  // grouping and sorting for every update that thread streams.
  const runtimes = useWhileFocused(useHostStore((s) => s.runtimes))
  const ready = useHostStore((s) => s.ready)
  const hosted = useWhileFocused(useAllSessions())
  const { openDone, collapsed, toggleDone, toggleCollapsed } = usePrefs()

  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<'attention' | 'recent'>('attention')
  const [hostFilter, setHostFilter] = useState('all')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ session: SessionView } | null>(null)
  const [hostMenu, setHostMenu] = useState(false)
  const [sortMenu, setSortMenu] = useState(false)
  // Rows on screen at first paint ease in one after another; rows scrolled to later just appear.
  const firstPaint = useRef(true)
  useEffect(() => {
    const timer = setTimeout(() => (firstPaint.current = false), 700)
    return () => clearTimeout(timer)
  }, [])
  const openMenu = useCallback((session: SessionView) => setMenu({ session }), [])

  const selectedHost = entries.some((e) => e.key === hostFilter) ? hostFilter : 'all'
  const hostName = (key: string) =>
    runtimes[key]?.host?.name ?? entries.find((e) => e.key === key)?.name ?? 'Host'
  const online = entries.filter((e) => runtimes[e.key]?.connection === 'connected').length

  const all = hosted.filter((h) => selectedHost === 'all' || h.hostKey === selectedHost)
  const hostOf = useMemo(() => new Map(hosted.map((h) => [h.session.id, h.hostKey])), [hosted])
  const needsYou = all.filter((h) => h.session.status === 'needs-you').length

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const visible = all
      .map((h) => h.session)
      .filter(
        (s) =>
          !searching ||
          !q ||
          `${s.title} ${s.projectless ? 'No project' : s.projectPath} ${s.branch ?? ''} ${activityLine(s)}`
            .toLowerCase()
            .includes(q),
      )
      .filter((s) =>
        filter === 'all'
          ? true
          : filter === 'needs-you'
            ? s.status === 'needs-you'
            : isFiledAway(s),
      )
      .sort(
        (a, b) =>
          (sort === 'attention' ? PRIORITY[a.status] - PRIORITY[b.status] : 0) ||
          b.updatedAt - a.updatedAt,
      )

    // Sessions of one repository sit together; the same path on two hosts is two repositories.
    const groups = new Map<string, SessionView[]>()
    const keyOf = (s: SessionView) =>
      `${hostOf.get(s.id)}\n${s.projectless ? 'no-project' : s.projectPath}`
    for (const s of visible) groups.set(keyOf(s), [...(groups.get(keyOf(s)) ?? []), s])

    const out: Row[] = []
    for (const [key, list] of groups) {
      const first = list[0]!
      const hostKey = hostOf.get(first.id) ?? ''
      const isCollapsed = collapsed.includes(key)
      out.push({
        kind: 'folder',
        key: `f:${key}`,
        name: first.projectless ? 'No project' : folderName(first.projectPath),
        host: hostName(hostKey),
        collapsed: isCollapsed,
        hostKey,
        path: first.projectless ? '' : first.projectPath,
      })
      if (isCollapsed) continue
      // Sessions another session started sit under it.
      const push = (sessions: SessionView[]) =>
        nestSessions(sessions).forEach(({ session, depth }) =>
          out.push({ kind: 'session', key: session.id, session, hostKey, depth }),
        )
      if (filter === 'done') {
        push(list)
        continue
      }
      const { active, done } = splitDone(list)
      push(active)
      if (done.length > 0) {
        const open = doneOpen({
          chosen: openDone.includes(key),
          searching: searching && q !== '',
          done,
        })
        out.push({ kind: 'done', key: `d:${key}`, count: done.length, open, groupKey: key })
        if (open) push(done)
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, hostOf, query, searching, filter, sort, collapsed, openDone, runtimes])

  const tab = (id: Filter, label: string, badge?: number) => (
    <Pressable
      key={id}
      onPress={() => setFilter(id)}
      style={[styles.tab, filter === id && { backgroundColor: colors.active }]}
    >
      <Text
        size={13}
        weight={filter === id ? 'medium' : 'regular'}
        color={filter === id ? colors.text : colors.muted}
      >
        {label}
      </Text>
      {badge ? (
        <View style={styles.badge}>
          <Text size={11} color={colors.accent}>
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  )

  const menuItems = (session: SessionView): MenuItem[] => {
    const action = doneMenuAction(session)
    return [
      {
        id: 'done',
        label: action.label,
        hint: action.hint,
        icon: action.kind === 'restore' ? ArrowUUpLeft : Checks,
        disabled: action.kind === 'busy',
        onSelect: () => void setSessionDone(session.id, action.kind === 'file'),
      },
      {
        id: 'delete',
        label: 'Delete',
        hint: 'Removes the conversation. Your folder and files stay.',
        icon: Trash,
        danger: true,
        onSelect: () =>
          Alert.alert('Delete this conversation?', session.title, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () =>
                void deleteSession(session.id).catch((err: unknown) =>
                  Alert.alert('Could not delete', err instanceof Error ? err.message : String(err)),
                ),
            },
          ]),
      },
    ]
  }

  const header = (
    <View>
      <View style={styles.top}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <Logo size={22} />
          <Text size={15} weight="semibold">
            BeddCode
          </Text>
        </View>
        <Pressable style={styles.hostPill} onPress={() => setHostMenu(true)}>
          <Icon icon={Monitor} size={15} />
          <Muted size={12.5} numberOfLines={1}>
            {selectedHost === 'all' ? 'All hosts' : hostName(selectedHost)}
          </Muted>
          <Icon icon={CaretDown} size={12} />
        </Pressable>
      </View>
      <View style={styles.actions}>
        <Pressable style={styles.newRow} onPress={() => router.push('/new')}>
          <Icon icon={NotePencil} size={19} color={colors.textSecondary} />
          <Text size={14}>New session</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', gap: 18 }}>
          <Pressable
            hitSlop={8}
            onPress={() => setSearching((v) => !v)}
            accessibilityLabel="Search"
          >
            <Icon icon={searching ? X : MagnifyingGlass} size={20} />
          </Pressable>
          <Pressable
            hitSlop={8}
            onPress={() =>
              router.push({
                // Typed routes learn the new screen the next time Expo starts.
                pathname: '/history' as '/new',
                params: selectedHost === 'all' ? {} : { host: selectedHost },
              })
            }
            accessibilityLabel="Resume an earlier conversation"
          >
            <Icon icon={ClockCounterClockwise} size={20} />
          </Pressable>
          <Pressable
            hitSlop={8}
            onPress={() =>
              router.push({
                pathname: '/folders/add',
                params: selectedHost === 'all' ? {} : { host: selectedHost },
              })
            }
            accessibilityLabel="Add a folder"
          >
            <Icon icon={FolderSimplePlus} size={20} />
          </Pressable>
        </View>
      </View>
      {searching && (
        <View style={styles.search}>
          <Icon icon={MagnifyingGlass} size={16} color={colors.faint} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search sessions"
            placeholderTextColor={colors.faint}
            style={styles.searchInput}
          />
        </View>
      )}
      <View style={styles.tabs}>
        {tab('all', `All ${all.filter((h) => !isFiledAway(h.session)).length}`)}
        {tab('needs-you', 'Needs you', needsYou)}
        {tab('done', 'Done')}
        <View style={{ flex: 1 }} />
        <Pressable style={styles.sort} onPress={() => setSortMenu(true)}>
          <Icon icon={SortDescending} size={15} />
          <Muted size={12.5}>{sort === 'attention' ? 'Attention first' : 'Recent first'}</Muted>
        </Pressable>
      </View>
    </View>
  )

  const empty = !ready ? null : entries.length === 0 ? (
    <View style={styles.empty}>
      <Text size={17} weight="semibold">
        Add your first host
      </Text>
      <Muted size={13.5} style={{ textAlign: 'center', lineHeight: 20 }}>
        BeddCode runs agents on your computers. Pair this phone with one on your tailnet to see and
        drive its sessions.
      </Muted>
      <Button
        label="Add a host"
        kind="primary"
        onPress={() => router.push('/hosts/add')}
        style={{ alignSelf: 'stretch' }}
      />
    </View>
  ) : (
    <View style={styles.empty}>
      <Muted size={13.5} style={{ textAlign: 'center' }}>
        {filter === 'needs-you'
          ? 'No sessions need your attention right now.'
          : filter === 'done'
            ? 'Nothing is filed under Done yet.'
            : online === 0
              ? 'Connecting to your hosts…'
              : 'No sessions yet. Start one with New session.'}
      </Muted>
    </View>
  )

  return (
    <Screen>
      {/* Pinned: only the sessions below scroll. */}
      <View style={{ paddingHorizontal: 8 }}>{header}</View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        ListEmptyComponent={empty ?? undefined}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        windowSize={9}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        renderItem={({ item, index }) => {
          if (item.kind === 'folder') {
            return (
              <PressableScale
                scaleTo={0.985}
                style={styles.folder}
                onPress={() => {
                  animateLayout()
                  toggleCollapsed(item.key.slice(2))
                }}
              >
                <Icon
                  icon={item.collapsed ? CaretRight : CaretDown}
                  size={12}
                  color={colors.faint}
                />
                <Icon icon={FolderSimple} size={17} />
                <Text size={13.5} weight="medium">
                  {item.name}
                </Text>
                <Faint size={13} numberOfLines={1} style={{ flex: 1 }}>
                  {item.host}
                </Faint>
                <Pressable
                  hitSlop={10}
                  accessibilityLabel={`New session in ${item.name}`}
                  onPress={() =>
                    router.push({
                      pathname: '/new',
                      params: { host: item.hostKey, folder: item.path || 'none' },
                    })
                  }
                >
                  <Icon icon={Plus} size={17} color={colors.faint} />
                </Pressable>
              </PressableScale>
            )
          }
          if (item.kind === 'done') {
            return (
              <PressableScale
                scaleTo={0.985}
                style={styles.doneToggle}
                onPress={() => {
                  animateLayout()
                  toggleDone(item.groupKey)
                }}
              >
                <Icon icon={item.open ? CaretDown : CaretRight} size={12} color={colors.faint} />
                <Faint size={12.5}>Done</Faint>
                <Faint size={12.5}>{item.count}</Faint>
              </PressableScale>
            )
          }
          return (
            <SessionRow
              session={item.session}
              depth={item.depth ?? 0}
              agent={
                runtimes[item.hostKey]?.providers.find((p) => p.id === item.session.instanceId)
                  ?.label ?? item.session.instanceId
              }
              onLongPress={openMenu}
              intro={firstPaint.current ? index : -1}
            />
          )
        }}
      />
      <View style={styles.footer}>
        <Pressable style={styles.settings} onPress={() => router.push('/settings')}>
          <Icon icon={Gear} size={18} color={colors.textSecondary} />
          <Text size={14} color={colors.textSecondary}>
            Settings
          </Text>
        </Pressable>
        <Muted size={13}>
          {entries.length === 0
            ? 'No hosts'
            : `${online} of ${entries.length} host${entries.length === 1 ? '' : 's'} online`}
        </Muted>
      </View>

      <MenuSheet
        visible={menu !== null}
        title={menu?.session.title}
        items={menu ? menuItems(menu.session) : []}
        onClose={() => setMenu(null)}
      />
      <MenuSheet
        visible={hostMenu}
        title="Show sessions from"
        onClose={() => setHostMenu(false)}
        items={[
          {
            id: 'all',
            label: 'All hosts',
            selected: selectedHost === 'all',
            onSelect: () => setHostFilter('all'),
          },
          ...entries.map((e) => ({
            id: e.key,
            label: hostName(e.key),
            hint: runtimes[e.key]?.connection === 'connected' ? 'Online' : 'Offline',
            selected: selectedHost === e.key,
            onSelect: () => setHostFilter(e.key),
          })),
          {
            id: 'add-host',
            label: 'Add a host…',
            icon: Plus,
            onSelect: () => router.push('/hosts/add'),
          },
        ]}
      />
      <MenuSheet
        visible={sortMenu}
        title="Sort by"
        onClose={() => setSortMenu(false)}
        items={[
          {
            id: 'attention',
            label: 'Attention first',
            selected: sort === 'attention',
            onSelect: () => setSort('attention'),
          },
          {
            id: 'recent',
            label: 'Recent first',
            selected: sort === 'recent',
            onSelect: () => setSort('recent'),
          },
        ]}
      />
    </Screen>
  )
}

/** Only a row whose session, depth or label changed is drawn again: streaming elsewhere leaves it be. */
const SessionRow = memo(function SessionRow({
  session,
  depth,
  agent,
  onLongPress,
  intro,
}: {
  session: SessionView
  depth: number
  agent: string
  onLongPress(session: SessionView): void
  /** The row's place among those on screen at first paint, for a staggered entrance; -1 for none. */
  intro: number
}) {
  const note = sessionNote(session)
  const row = (
    <PressableScale
      scaleTo={0.985}
      onPress={() => router.push({ pathname: '/session/[id]', params: { id: session.id } })}
      onLongPress={() => onLongPress(session)}
      style={({ pressed }) => [
        styles.session,
        depth > 0 && styles.child,
        depth > 0 && { marginLeft: 14 * Math.min(depth, 3) },
        pressed && { backgroundColor: colors.hover },
      ]}
    >
      <View style={styles.lead}>
        <StatusDot session={session} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={styles.line}>
          <Text size={14.5} numberOfLines={1} style={{ flex: 1 }}>
            {session.title}
          </Text>
          <Muted size={12}>{timeAgo(session.updatedAt)}</Muted>
        </View>
        {note ? (
          <Text
            size={13}
            color={session.status === 'needs-you' ? colors.accent : colors.muted}
            numberOfLines={1}
          >
            {note}
          </Text>
        ) : null}
        <View style={styles.line}>
          <View style={styles.where}>
            {session.branch ? <Icon icon={GitBranch} size={12} color={colors.faint} /> : null}
            <Text size={12} mono color={colors.faint} numberOfLines={1} style={{ flexShrink: 1 }}>
              {[
                session.branch,
                session.schedule ? `scheduled: ${session.schedule.name}` : undefined,
                session.parent ? `started by an agent · ${agent}` : agent,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <Diffstat added={session.added} removed={session.removed} />
        </View>
      </View>
    </PressableScale>
  )
  return intro >= 0 ? <FadeIn delay={Math.min(intro, 10) * 28}>{row}</FadeIn> : row
})

const styles = StyleSheet.create({
  child: {
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
  },
  hostPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.raised,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 11,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
    paddingVertical: 9,
  },
  tabs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.control,
  },
  badge: {
    backgroundColor: colors.accentSoft,
    borderRadius: 8,
    paddingHorizontal: 6,
    minWidth: 16,
    alignItems: 'center',
  },
  sort: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  folder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 14,
    paddingBottom: 6,
  },
  doneToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  session: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radius.panel,
  },
  lead: { width: 14, paddingTop: 7, alignItems: 'center' },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  where: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  settings: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  empty: { alignItems: 'center', gap: 12, paddingHorizontal: 28, paddingTop: 80 },
})
