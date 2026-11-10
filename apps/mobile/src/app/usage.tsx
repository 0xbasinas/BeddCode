import type { UsageLimits, UsageSummary } from '@beddcode/contracts'
import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'

import {
  formatCost,
  formatReset,
  formatTokens,
  planName,
  tokensOf,
} from '@/features/settings/usageFormat'
import { hostRequest, useHostStore } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Header } from '@/ui/Header'
import { Screen } from '@/ui/Screen'
import { Faint, Muted, Text } from '@/ui/Text'

/** Token and cost use for this host, plus each agent's reported plan limits. */
export default function UsageScreen() {
  const entries = useHostStore((s) => s.entries)
  const [hostKey, setHostKey] = useState(entries[0]?.key)
  const [summary, setSummary] = useState<UsageSummary>()
  const [limits, setLimits] = useState<UsageLimits[]>()
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    if (!hostKey) return
    setError(undefined)
    try {
      const [s, l] = await Promise.all([
        hostRequest(hostKey, 'usage.summary', { days: 7 }),
        hostRequest(hostKey, 'usage.limits', {}),
      ])
      setSummary(s)
      setLimits(l)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [hostKey])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <Screen>
      <Header title="Usage" subtitle="The last seven days on this host" />
      <ScrollView contentContainerStyle={styles.body}>
        {entries.length > 1 ? (
          <View style={styles.chips}>
            {entries.map((e) => (
              <Pressable
                key={e.key}
                style={[styles.chip, hostKey === e.key && styles.chipOn]}
                onPress={() => setHostKey(e.key)}
              >
                <Text size={12.5}>{e.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {error ? (
          <Text size={13} color={colors.danger}>
            {error}
          </Text>
        ) : null}
        {summary ? (
          <View style={styles.card}>
            <Text size={15} weight="medium">
              Totals
            </Text>
            <Text size={14}>{formatTokens(tokensOf(summary.totals))}</Text>
            {formatCost(summary.totals.costUsd) ? (
              <Muted size={13}>{formatCost(summary.totals.costUsd)}</Muted>
            ) : null}
            <Faint size={11.5}>
              In {formatTokens(summary.totals.inputTokens)} · out{' '}
              {formatTokens(summary.totals.outputTokens)}
            </Faint>
          </View>
        ) : !error ? (
          <Muted size={13.5}>{hostKey ? 'Loading…' : 'Add a host first.'}</Muted>
        ) : null}
        {summary?.byAgent?.length ? (
          <View style={styles.card}>
            <Text size={15} weight="medium">
              By agent
            </Text>
            {summary.byAgent.map((row) => (
              <View key={row.instanceId ?? row.label} style={styles.row}>
                <Text size={13.5} style={{ flex: 1 }} numberOfLines={1}>
                  {row.label}
                </Text>
                <Muted size={12.5}>{formatTokens(tokensOf(row))}</Muted>
              </View>
            ))}
          </View>
        ) : null}
        {limits && limits.length > 0 ? (
          <View style={styles.card}>
            <Text size={15} weight="medium">
              Plan limits
            </Text>
            {limits.map((l) => (
              <View key={l.instanceId} style={{ gap: 2 }}>
                <Text size={13.5}>
                  {l.label}
                  {planName(l.plan) ? ` · ${planName(l.plan)}` : ''}
                </Text>
                {l.windows.map((w) => (
                  <Faint key={w.id} size={11.5}>
                    {w.label}: {Math.round(w.usedPercent)}%
                    {formatReset(w.resetsAt) ? ` · ${formatReset(w.resetsAt)}` : ''}
                  </Faint>
                ))}
                {l.note ? <Faint size={11.5}>{l.note}</Faint> : null}
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 14, paddingBottom: 40 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.active },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    padding: 14,
    gap: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
})
