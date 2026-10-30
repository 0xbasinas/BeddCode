import { PROTOCOL_VERSION } from '@beddcode/contracts'
import type { HostEntry } from '@beddcode/client-runtime'
import Constants from 'expo-constants'
import { router } from 'expo-router'
import {
  Bell,
  FolderSimple,
  FolderSimplePlus,
  HardDrives,
  Plus,
  Robot,
  Trash,
  X,
} from 'phosphor-react-native'
import { useState, type ReactNode } from 'react'
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native'
import type { AlertEvents } from '@beddcode/contracts'

import {
  activeRoute,
  hostRequest,
  refreshProjects,
  removeRemoteHost,
  useHostStore,
  useRuntime,
} from '@/host/store'
import { applyHostAlerts, hostAlertPrefs, pushUnavailableReason, usePushPrefs } from '@/host/push'
import { colors, radius } from '@/theme/tokens'
import { Header } from '@/ui/Header'
import { Icon } from '@/ui/Icon'
import { Screen } from '@/ui/Screen'
import { Faint, Muted, Text } from '@/ui/Text'

const AGENT_STATUS = {
  ready: { label: 'Ready', color: colors.success },
  'needs-sign-in': { label: 'Needs sign-in', color: colors.accent },
  'not-installed': { label: 'Not installed', color: colors.faint },
  error: { label: 'Error', color: colors.danger },
} as const

/** A titled group, like the desktop's settings sections. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Faint size={11.5} weight="semibold" style={styles.sectionTitle}>
        {title}
      </Faint>
      {children}
    </View>
  )
}

function Row({ children, last }: { children: ReactNode; last?: boolean }) {
  return <View style={[styles.row, !last && styles.rowDivider]}>{children}</View>
}

function HostCard({ entry }: { entry: HostEntry }) {
  const runtime = useRuntime(entry.key)
  const state = runtime.connection
  const online = state === 'connected'
  const name = runtime.host?.name ?? entry.name
  const route = (activeRoute(entry.key) ?? entry.routes[0] ?? '')
    .replace(/^wss?:\/\//, '')
    .replace(/\/ws$/, '')

  const forget = () =>
    Alert.alert(
      `Forget ${name}?`,
      'This phone will stop connecting to it. Pair again to bring it back.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget', style: 'destructive', onPress: () => removeRemoteHost(entry.key) },
      ],
    )

  const removeFolder = (path: string, label: string) =>
    Alert.alert(`Remove ${label}?`, 'The folder stays on the computer. Only BeddCode forgets it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void hostRequest(entry.key, 'projects.remove', { path })
            .then(() => refreshProjects(entry.key))
            .catch((err: unknown) =>
              Alert.alert('Could not remove it', err instanceof Error ? err.message : String(err)),
            ),
      },
    ])

  const stateText = online
    ? 'Online'
    : state === 'denied'
      ? 'Refused: pair again'
      : state === 'reconnecting'
        ? 'Reconnecting…'
        : 'Connecting…'
  const stateColor = online ? colors.success : state === 'denied' ? colors.danger : colors.muted

  return (
    <View style={styles.card}>
      <Row>
        <Icon icon={HardDrives} size={22} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={14.5} weight="medium">
            {name}
          </Text>
          <Text size={11.5} mono color={colors.muted} numberOfLines={1}>
            {route}
          </Text>
          {runtime.host ? (
            <Faint size={11.5}>
              {runtime.host.platform} · BeddCode {runtime.host.version}
            </Faint>
          ) : null}
        </View>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: stateColor }]} />
          <Text size={12} color={stateColor}>
            {stateText}
          </Text>
        </View>
      </Row>

      <Row>
        <Icon icon={FolderSimple} size={18} />
        <Text size={13.5} style={{ flex: 1 }}>
          Folders
        </Text>
        <Pressable
          hitSlop={8}
          style={styles.add}
          onPress={() => router.push({ pathname: '/folders/add', params: { host: entry.key } })}
        >
          <Icon icon={FolderSimplePlus} size={16} color={colors.textSecondary} />
          <Text size={12.5} color={colors.textSecondary}>
            Add
          </Text>
        </Pressable>
      </Row>
      {runtime.projects.length === 0 ? (
        <Row>
          <Muted size={12.5}>
            {online ? 'No folders added yet.' : 'Connect to see its folders.'}
          </Muted>
        </Row>
      ) : (
        runtime.projects.map((p) => (
          <Row key={p.path}>
            <View style={{ flex: 1, gap: 1 }}>
              <Text size={13.5} numberOfLines={1}>
                {p.name}
              </Text>
              <Faint size={11} mono numberOfLines={1}>
                {p.path}
              </Faint>
            </View>
            <Pressable
              hitSlop={10}
              onPress={() => removeFolder(p.path, p.name)}
              accessibilityLabel={`Remove ${p.name}`}
            >
              <Icon icon={X} size={15} />
            </Pressable>
          </Row>
        ))
      )}

      <Row>
        <Icon icon={Robot} size={18} />
        <Text size={13.5} style={{ flex: 1 }}>
          Agents
        </Text>
      </Row>
      {runtime.providers.length === 0 ? (
        <Row>
          <Muted size={12.5}>{online ? 'No agents found.' : 'Connect to see its agents.'}</Muted>
        </Row>
      ) : (
        runtime.providers.map((p) => {
          const status = AGENT_STATUS[p.status]
          return (
            <Row key={p.id}>
              <Text size={13.5} style={{ flex: 1 }} numberOfLines={1}>
                {p.label}
                {p.version ? <Faint size={12}> {p.version}</Faint> : null}
              </Text>
              <Text size={12} color={status.color}>
                {status.label}
              </Text>
            </Row>
          )
        })
      )}

      <HostAlerts hostKey={entry.key} online={online} />

      <Pressable style={styles.forget} onPress={forget}>
        <Icon icon={Trash} size={16} color={colors.danger} />
        <Text size={13} color={colors.danger}>
          Forget this host
        </Text>
      </Pressable>
    </View>
  )
}

const ALERT_EVENTS: { key: keyof AlertEvents; label: string }[] = [
  { key: 'needsYou', label: 'An agent needs you' },
  { key: 'turnDone', label: 'A turn finishes' },
  { key: 'error', label: 'A turn fails' },
  { key: 'schedule', label: 'A scheduled run finishes' },
]

/** This phone's push alerts from one host: on or off, and for which happenings. */
function HostAlerts({ hostKey, online }: { hostKey: string; online: boolean }) {
  const prefs = usePushPrefs((s) => hostAlertPrefs(s.hosts, hostKey))
  const save = usePushPrefs((s) => s.set)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const unavailable = pushUnavailableReason()

  const change = async (next: typeof prefs) => {
    setBusy(true)
    setProblem(undefined)
    try {
      await applyHostAlerts(hostKey, next)
      save(hostKey, next)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Row>
        <Icon icon={Bell} size={18} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={13.5}>Push alerts</Text>
          <Faint size={11.5}>Even when the app is closed. Tap one to open its session.</Faint>
        </View>
        <Switch
          value={prefs.enabled}
          disabled={busy || !online || (!!unavailable && !prefs.enabled)}
          onValueChange={(enabled) => void change({ ...prefs, enabled })}
          trackColor={{ true: colors.accent, false: colors.raised }}
          accessibilityLabel="Push alerts from this host"
        />
      </Row>
      {problem || unavailable ? (
        <Row>
          <Muted size={12}>{problem ?? unavailable}</Muted>
        </Row>
      ) : null}
      {prefs.enabled
        ? ALERT_EVENTS.map((e) => (
            <Row key={e.key}>
              <Text size={13} style={{ flex: 1, paddingLeft: 30 }}>
                {e.label}
              </Text>
              <Switch
                value={prefs.events[e.key]}
                disabled={busy || !online}
                onValueChange={(on) =>
                  void change({ ...prefs, events: { ...prefs.events, [e.key]: on } })
                }
                trackColor={{ true: colors.accent, false: colors.raised }}
                accessibilityLabel={e.label}
              />
            </Row>
          ))
        : null}
    </>
  )
}

/** The phone's settings: the hosts it is paired with (their folders and agents), and the app. */
export default function SettingsScreen() {
  const entries = useHostStore((s) => s.entries)
  const [checking, setChecking] = useState(false)

  const checkForUpdate = async () => {
    setChecking(true)
    try {
      const response = await fetch(
        'https://api.github.com/repos/0xbasinas/BeddCode/releases/latest',
      )
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
      const release: { html_url?: string; assets?: { name: string }[] } = await response.json()
      const apk = release.assets?.find((asset) =>
        /^BeddCode-.*-android-build\d+\.apk$/.test(asset.name),
      )
      if (!apk) throw new Error('The latest release does not have an Android APK yet.')
      const build = Number(apk.name.match(/-build(\d+)\.apk$/)?.[1])
      const installed = Constants.expoConfig?.android?.versionCode
      if (installed != null && build <= installed) {
        Alert.alert('Up to date', 'You already have the latest Android release.')
      } else {
        Alert.alert(
          'Update available',
          'Open the release page to download and install the latest APK.',
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Open release',
              onPress: () =>
                void Linking.openURL('https://github.com/0xbasinas/BeddCode/releases/latest'),
            },
          ],
        )
      }
    } catch (error) {
      Alert.alert(
        'Could not check for updates',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      setChecking(false)
    }
  }

  return (
    <Screen>
      <Header title="Settings" />
      <ScrollView contentContainerStyle={styles.body}>
        <Section title="HOSTS">
          {entries.length === 0 ? (
            <View style={styles.card}>
              <Row last>
                <Muted size={13}>No hosts paired yet.</Muted>
              </Row>
            </View>
          ) : (
            entries.map((e) => <HostCard key={e.key} entry={e} />)
          )}
          <Pressable style={styles.addHost} onPress={() => router.push('/hosts/add')}>
            <Icon icon={Plus} size={17} color={colors.textSecondary} />
            <Text size={14} color={colors.textSecondary}>
              Add a host
            </Text>
          </Pressable>
        </Section>

        <Section title="ABOUT">
          <View style={styles.card}>
            <Row>
              <Text size={13.5} style={{ flex: 1 }}>
                BeddCode for phones
              </Text>
              <Muted size={12.5}>{Constants.expoConfig?.version ?? '0.0.0'}</Muted>
            </Row>
            <Row>
              <Text size={13.5} style={{ flex: 1 }}>
                Protocol
              </Text>
              <Muted size={12.5}>{PROTOCOL_VERSION}</Muted>
            </Row>
            {Platform.OS === 'android' ? (
              <Pressable
                disabled={checking}
                onPress={() => void checkForUpdate()}
                accessibilityRole="button"
              >
                <Row last>
                  <Text size={13.5} style={{ flex: 1 }}>
                    {checking ? 'Checking for updates…' : 'Check for updates'}
                  </Text>
                  <Muted size={12.5}>GitHub releases</Muted>
                </Row>
              </Pressable>
            ) : null}
          </View>
        </Section>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 22, paddingBottom: 40 },
  sectionTitle: { letterSpacing: 0.6, paddingHorizontal: 4 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel + 2,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.raised,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  forget: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  addHost: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radius.panel + 2,
    paddingVertical: 14,
  },
})
