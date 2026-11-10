import { Hand, Monitor, Play, Stop } from 'phosphor-react-native'
import { useRef, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native'

import { usePolled } from '@/features/git/usePolled'
import { hostRequest, interrupt, useSession, useSessionHostKey } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Header } from '@/ui/Header'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'

/**
 * What the agent is doing on the computer: its latest window picture, recent actions, and the
 * controls to take over or stop the turn.
 */
export function DesktopPane({ sessionId, active }: { sessionId: string; active: boolean }) {
  const session = useSession(sessionId)
  const hostKey = useSessionHostKey(sessionId)
  const lastAt = useRef(0)
  const [picture, setPicture] = useState<{ data: string; mime: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const running = session?.status === 'running'

  const view = usePolled(
    async () => {
      if (!hostKey) throw new Error('That host is not connected')
      const v = await hostRequest(hostKey, 'computer.view', {
        sessionId,
        ...(lastAt.current ? { since: lastAt.current } : {}),
      })
      if (v.image) setPicture(v.image)
      lastAt.current = v.at
      return v
    },
    `${hostKey ?? ''}:${sessionId}`,
    Boolean(hostKey && active),
    running ? 1000 : 3000,
  )
  const v = view.data

  const control = async (paused: boolean) => {
    if (!hostKey) return
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'computer.control', { sessionId, paused })
      view.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await interrupt(sessionId)
      view.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Desktop"
        subtitle={v ? (v.paused ? 'You control' : v.active ? 'Agent working' : 'Idle') : 'Computer use'}
      />
      {!hostKey ? (
        <Muted size={13.5} style={styles.empty}>
          This session is not available.
        </Muted>
      ) : view.loading && !v ? (
        <Muted size={13.5} style={styles.empty}>
          Loading…
        </Muted>
      ) : view.error ? (
        <View style={styles.empty}>
          <Muted size={13.5}>The desktop view is unavailable</Muted>
          <Faint size={12}>{view.error}</Faint>
        </View>
      ) : !v?.enabled ? (
        <View style={styles.empty}>
          <Icon icon={Monitor} size={28} />
          <Text size={15} style={{ textAlign: 'center' }}>
            This session cannot use the computer
          </Text>
          <Muted size={13} style={{ textAlign: 'center' }}>
            Turn on “Use computer” when starting a session.
          </Muted>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.bar}>
            {v.paused ? (
              <Pressable style={styles.btn} disabled={busy} onPress={() => void control(false)}>
                <Icon icon={Play} size={14} />
                <Text size={12.5}>Hand back</Text>
              </Pressable>
            ) : (
              <Pressable style={styles.btn} disabled={busy} onPress={() => void control(true)}>
                <Icon icon={Hand} size={14} />
                <Text size={12.5}>Take over</Text>
              </Pressable>
            )}
            <Pressable style={styles.btn} disabled={busy || !running} onPress={() => void stop()}>
              <Icon icon={Stop} size={14} />
              <Text size={12.5}>Stop</Text>
            </Pressable>
          </View>
          {error ? (
            <Text size={12.5} color={colors.danger} style={{ paddingHorizontal: 14 }}>
              {error}
            </Text>
          ) : null}
          <View style={styles.shot}>
            {picture ? (
              <Image
                source={{ uri: `data:${picture.mime};base64,${picture.data}` }}
                style={styles.image}
                resizeMode="contain"
                accessibilityLabel={v.title ? `${v.app}: ${v.title}` : 'The window the agent last looked at'}
              />
            ) : (
              <Muted size={13}>The agent has not looked at a window yet.</Muted>
            )}
          </View>
          {v.app ? (
            <Faint size={12} style={{ paddingHorizontal: 14, paddingVertical: 6 }} numberOfLines={1}>
              {v.app}
              {v.title ? ` · ${v.title}` : ''}
            </Faint>
          ) : null}
          <ScrollView
            style={{ maxHeight: 120 }}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 16, gap: 4 }}
          >
            {v.actions.length === 0 ? (
              <Muted size={12.5}>No actions yet.</Muted>
            ) : (
              [...v.actions].reverse().map((a, i) => (
                <Faint key={`${i}-${a}`} size={12} numberOfLines={2}>
                  {a}
                </Faint>
              ))
            )}
          </ScrollView>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 8 },
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.hover,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  shot: {
    flex: 1,
    marginHorizontal: 12,
    backgroundColor: colors.code,
    borderRadius: radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    minHeight: 180,
  },
  image: { width: '100%', height: '100%' },
})
