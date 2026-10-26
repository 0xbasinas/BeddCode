import { folderName, timeAgo } from '@beddcode/client-runtime'
import type { HistoryEntry } from '@beddcode/contracts'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native'

import { hostRequest, importSession, useHostStore, useRuntime } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Header } from '@/ui/Header'
import { Screen } from '@/ui/Screen'
import { Faint, Muted, Text } from '@/ui/Text'

/** Earlier conversations of an agent, including ones started in its own CLI; one comes in as a session. */
export default function HistoryScreen() {
  const params = useLocalSearchParams<{ host?: string }>()
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const host =
    entries.find((e) => e.key === params.host)?.key ??
    entries.find((e) => runtimes[e.key]?.connection === 'connected')?.key ??
    entries[0]?.key
  const runtime = useRuntime(host)
  const agents = runtime.providers.filter(
    (p) => p.status === 'ready' && p.capabilities.history === true,
  )
  const [agentId, setAgentId] = useState<string>()
  const agent = agents.find((a) => a.id === agentId) ?? agents[0]
  const [list, setList] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string>()
  const [opening, setOpening] = useState<string>()

  useEffect(() => {
    if (!host || !agent) return
    let cancelled = false
    setList(null)
    setError(undefined)
    hostRequest(host, 'history.list', { instanceId: agent.id }).then(
      (items) => !cancelled && setList(items),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      cancelled = true
    }
  }, [host, agent?.id])

  const open = async (item: HistoryEntry) => {
    if (!host || !agent || opening) return
    setOpening(item.id)
    setError(undefined)
    try {
      const id = await importSession(host, {
        instanceId: agent.id,
        providerSessionId: item.id,
        cwd: item.cwd,
      })
      router.replace({ pathname: '/session/[id]', params: { id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setOpening(undefined)
    }
  }

  return (
    <Screen>
      <Header title="Resume a conversation" subtitle="From the agent's own CLI" />
      {agents.length === 0 ? (
        <View style={styles.empty}>
          <Muted>None of the agents on this host keep a history BeddCode can read.</Muted>
        </View>
      ) : (
        <>
          {agents.length > 1 && (
            <View style={styles.chips}>
              {agents.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => setAgentId(a.id)}
                  style={[styles.chip, a.id === agent?.id && styles.chipOn]}
                >
                  <Text size={13}>{a.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {error ? (
            <Text size={13} color={colors.danger} style={styles.error}>
              {error}
            </Text>
          ) : null}
          {list === null && !error ? (
            <ActivityIndicator style={styles.empty} color={colors.textSecondary} />
          ) : (
            <FlatList
              data={list ?? []}
              keyExtractor={(i) => i.id}
              ListEmptyComponent={
                error ? null : (
                  <View style={styles.empty}>
                    <Muted>Nothing to resume yet.</Muted>
                  </View>
                )
              }
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.row, opening === item.id && { opacity: 0.5 }]}
                  onPress={() => void open(item)}
                  disabled={!!opening}
                >
                  <Text size={14} numberOfLines={2}>
                    {item.title}
                  </Text>
                  <Faint size={12} numberOfLines={1}>
                    {[
                      item.cwd ? folderName(item.cwd) : undefined,
                      item.updatedAt ? timeAgo(item.updatedAt) : undefined,
                      item.imported ? 'already here' : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Faint>
                </Pressable>
              )}
            />
          )}
        </>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.raised },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  empty: { padding: 24, alignItems: 'center' },
  error: { paddingHorizontal: 16, paddingVertical: 8 },
})
