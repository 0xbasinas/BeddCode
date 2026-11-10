import { router } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { forkSession, prompt } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Faint, Text } from '@/ui/Text'

/**
 * How full the session's context window is, with compact (sends /compact when the agent has it)
 * and fork (starts a copy of this thread).
 */
export function ContextMeter({
  used,
  size,
  sessionId,
  hasCompact,
}: {
  used: number
  size: number
  sessionId: string
  hasCompact: boolean
}) {
  const pct = size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0
  const [busy, setBusy] = useState<'compact' | 'fork'>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const compact = async () => {
    setBusy('compact')
    setError(undefined)
    setNotice(undefined)
    try {
      await prompt(sessionId, '/compact')
      setNotice(hasCompact ? 'Asked the agent to compact this thread.' : 'Sent /compact. The agent may not offer that command.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  const fork = async () => {
    setBusy('fork')
    setError(undefined)
    setNotice(undefined)
    try {
      const id = await forkSession(sessionId)
      setNotice('A copy of this thread is ready.')
      router.push({ pathname: '/session/[id]', params: { id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.barTrack}>
          <View
            style={[
              styles.barFill,
              { width: `${pct}%`, backgroundColor: pct >= 85 ? colors.accent : colors.muted },
            ]}
          />
        </View>
        <Faint size={11}>Context {pct}%</Faint>
        <Pressable onPress={() => void compact()} disabled={!!busy} accessibilityRole="button">
          <Text size={11.5} color={colors.textSecondary}>
            {busy === 'compact' ? '…' : 'Compact'}
          </Text>
        </Pressable>
        <Pressable onPress={() => void fork()} disabled={!!busy} accessibilityRole="button">
          <Text size={11.5} color={colors.textSecondary}>
            {busy === 'fork' ? '…' : 'Fork'}
          </Text>
        </Pressable>
      </View>
      {notice ? <Faint size={11}>{notice}</Faint> : null}
      {error ? (
        <Text size={11} color={colors.danger}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}


const styles = StyleSheet.create({
  wrap: { gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barTrack: {
    flex: 1,
    height: 4,
    borderRadius: radius.control,
    backgroundColor: colors.raised,
    overflow: 'hidden',
  },
  barFill: { height: 4, borderRadius: radius.control },
})
