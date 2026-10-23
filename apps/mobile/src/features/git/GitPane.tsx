import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { useRuntime } from '@/host/store'
import { useWorkspace } from '@/host/workspace'
import { colors, radius } from '@/theme/tokens'
import { Muted, Text } from '@/ui/Text'
import { ChangesTab } from './ChangesTab'
import { CommitsTab } from './CommitsTab'
import { PullRequestTab } from './PullRequestTab'

type Tab = 'changes' | 'commits' | 'pr'

/** Changes, commits and the pull request of the session's branch: the desktop's Git pane. */
export function GitPane({ sessionId, active }: { sessionId: string; active: boolean }) {
  const { session, hostKey, cwd } = useWorkspace(sessionId)
  const runtime = useRuntime(hostKey)
  const [tab, setTab] = useState<Tab>('changes')

  if (!session || !hostKey || !cwd) {
    return (
      <View style={styles.center}>
        <Muted size={13.5}>Loading…</Muted>
      </View>
    )
  }

  // Everything refreshes when a turn ends or the connection comes back.
  const refreshKey = session.completedTurns * 1000 + runtime.epoch
  const common = { hostKey, cwd, refreshKey }

  const tabButton = (id: Tab, label: string) => (
    <Pressable
      key={id}
      style={[styles.tab, tab === id && { backgroundColor: colors.active }]}
      onPress={() => setTab(id)}
    >
      <Text
        size={13}
        weight={tab === id ? 'medium' : 'regular'}
        color={tab === id ? colors.text : colors.muted}
      >
        {label}
      </Text>
    </Pressable>
  )

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tabs}>
        <View style={styles.pill}>
          {tabButton('changes', 'Changes')}
          {tabButton('commits', 'Commits')}
          {tabButton('pr', 'PR')}
        </View>
      </View>
      {tab === 'changes' && (
        <ChangesTab
          {...common}
          sessionId={sessionId}
          instanceId={session.instanceId}
          active={active}
        />
      )}
      {tab === 'commits' && (
        <CommitsTab {...common} active={active} onOpenPr={() => setTab('pr')} />
      )}
      {tab === 'pr' && (
        <PullRequestTab
          {...common}
          sessionId={sessionId}
          instanceId={session.instanceId}
          active={active}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabs: { paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row' },
  pill: {
    flexDirection: 'row',
    gap: 2,
    backgroundColor: colors.raised,
    borderRadius: radius.panel,
    padding: 3,
  },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.control },
})
