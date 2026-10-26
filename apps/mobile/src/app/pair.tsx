import {
  pairWithLink,
  parsePairLink,
  type HostEntry,
  type PairLink,
} from '@beddcode/client-runtime'
import * as Device from 'expo-device'
import { router, useLocalSearchParams } from 'expo-router'
import { Check, HardDrives, X } from 'phosphor-react-native'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { addRemoteHost, useHostStore } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { Screen } from '@/ui/Screen'
import { Muted, Text } from '@/ui/Text'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const many = (v: string | string[] | undefined) =>
  v === undefined ? [] : Array.isArray(v) ? v : [v]

/**
 * Opened by a pairing link, e.g. from scanning the QR code with the phone's camera
 * (`beddcode://pair?c=…&r=…`). Asks once, pairs on the first address that answers, then connects.
 */
export default function PairScreen() {
  const params = useLocalSearchParams<{
    c?: string
    n?: string
    h?: string
    r?: string | string[]
    y?: string
    k?: string
  }>()
  const link: PairLink | null = useMemo(
    () =>
      // The app opening the link has already split it into parameters; put it back together.
      parsePairLink(
        `beddcode://pair?${[
          ['c', one(params.c)],
          ['n', one(params.n)],
          ['h', one(params.h)],
          ...many(params.r).map((r) => ['r', r] as const),
          ['y', one(params.y)],
          ['k', one(params.k)],
        ]
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
          .join('&')}`,
      ),
    [params.c, params.n, params.h, params.r, params.y, params.k],
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [paired, setPaired] = useState<HostEntry>()
  const alive = useRef(true)
  const runtime = useHostStore((s) => (paired ? s.runtimes[paired.key] : undefined))
  const connected = runtime?.connection === 'connected'

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const pair = async () => {
    if (!link || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const entry = await pairWithLink(link, Device.deviceName ?? 'Phone')
      if (!alive.current) return
      addRemoteHost(entry)
      setPaired(entry)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'))

  return (
    <Screen>
      <View style={styles.top}>
        <Text size={13} color={colors.textSecondary}>
          Pair with a computer
        </Text>
        <Pressable hitSlop={12} onPress={leave}>
          <Icon icon={X} size={20} />
        </Pressable>
      </View>
      <View style={styles.body}>
        {!link ? (
          <>
            <Text size={21} weight="semibold">
              This pairing link is not valid
            </Text>
            <Muted size={13}>
              Create a new code with Share this computer on the other computer and scan it again.
            </Muted>
          </>
        ) : paired ? (
          <View style={{ alignItems: 'center', gap: 14, paddingTop: 24 }}>
            <View
              style={[styles.badge, { backgroundColor: connected ? '#1c3322' : colors.raised }]}
            >
              <Icon icon={Check} size={26} color={connected ? colors.success : colors.muted} />
            </View>
            <Text size={19} weight="semibold" style={{ textAlign: 'center' }}>
              {connected ? `${paired.name} is connected` : `Connecting to ${paired.name}…`}
            </Text>
            <Muted size={13} style={{ textAlign: 'center' }}>
              {connected
                ? 'You can now run agents and open projects on this host.'
                : runtime?.connection === 'denied'
                  ? 'The host refused this pairing. Create a fresh code and scan it again.'
                  : 'Your pairing was saved. Waiting for the host to answer.'}
            </Muted>
          </View>
        ) : (
          <>
            <Text size={21} weight="semibold">
              Pair with {link.name ?? 'this computer'}?
            </Text>
            <View style={styles.card}>
              <Icon icon={HardDrives} size={22} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text size={13.5}>{link.name ?? 'Computer'}</Text>
                <Text size={11.5} mono color={colors.muted} numberOfLines={2}>
                  {link.routes[0]?.replace(/^wss?:\/\/|\/ws$/g, '') ?? 'through the relay'}
                </Text>
              </View>
            </View>
            <Muted size={13}>
              It will be able to run agents and open projects on that computer. Only continue if you
              just created this code yourself.
            </Muted>
          </>
        )}
        {error ? (
          <View style={styles.error}>
            <Text size={12.5} color={colors.danger}>
              {error}
            </Text>
          </View>
        ) : null}
        {link && !paired ? (
          <Button
            label={busy ? 'Pairing…' : 'Pair and connect'}
            kind="primary"
            onPress={() => void pair()}
            disabled={busy}
            style={styles.action}
          />
        ) : (
          <Button
            label="Done"
            kind="primary"
            onPress={() => router.replace('/')}
            style={styles.action}
          />
        )}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  body: { flex: 1, paddingHorizontal: 18, gap: 16 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.panel,
    padding: 12,
  },
  // Under the text, not pinned to the bottom edge, so it is always in view.
  action: { alignSelf: 'stretch', marginTop: 8 },
})
