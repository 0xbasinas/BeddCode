import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEFAULT_ALERT_EVENTS, type AlertEvents } from '@beddcode/contracts'
import { sessionOfAlert } from '@beddcode/client-runtime'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import type * as NotificationsModule from 'expo-notifications'
import { router } from 'expo-router'
import { Platform } from 'react-native'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { hostRequest, useHostStore } from './store'

type Notifications = typeof NotificationsModule

let loaded: Notifications | null | undefined

/** The notifications module, or null where this app has no native part for it (Expo Go on Android). */
function notifications(): Notifications | null {
  if (loaded === undefined) {
    try {
      loaded = require('expo-notifications') as Notifications
    } catch {
      loaded = null
    }
  }
  return loaded
}

/** The Android channel the host's alerts arrive on (it names it in each push). */
export const ALERT_CHANNEL = 'alerts'

interface HostAlertPrefs {
  enabled: boolean
  events: AlertEvents
}

interface PushState {
  /** Per paired host: whether this phone wants its alerts, and which. */
  hosts: Record<string, HostAlertPrefs>
  set(hostKey: string, prefs: HostAlertPrefs): void
}

export const usePushPrefs = create<PushState>()(
  persist(
    (set) => ({
      hosts: {},
      set: (hostKey, prefs) => set((s) => ({ hosts: { ...s.hosts, [hostKey]: prefs } })),
    }),
    { name: 'beddcode.push', storage: createJSONStorage(() => AsyncStorage) },
  ),
)

export const hostAlertPrefs = (hosts: PushState['hosts'], hostKey: string): HostAlertPrefs =>
  hosts[hostKey] ?? { enabled: false, events: DEFAULT_ALERT_EVENTS }

/** Why this build cannot get a push token, in words, or undefined when it can try. */
export function pushUnavailableReason(): string | undefined {
  if (Platform.OS === 'web') return 'Push alerts work in the phone app, not on the web.'
  if (!notifications())
    return 'Push alerts need the BeddCode app itself; Expo Go does not include them.'
  if (!Device.isDevice) return 'Push alerts need a real phone, not an emulator.'
  if (!projectId())
    return 'This build has no Expo project id (EAS_PROJECT_ID), so it cannot get a push token. Use an ntfy topic on the host instead.'
  return undefined
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined
}

let token: Promise<string> | undefined

/** Asks for permission (once) and this phone's Expo push token. Throws a readable reason. */
export function pushToken(): Promise<string> {
  token ??= (async () => {
    const reason = pushUnavailableReason()
    if (reason) throw new Error(reason)
    const Notifications = notifications()!
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ALERT_CHANNEL, {
        name: 'Agent alerts',
        description: 'When an agent finishes, needs you, fails, or a schedule runs',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 120, 200],
      })
    }
    let { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status
    if (status !== 'granted')
      throw new Error('Notifications are turned off for BeddCode in the phone’s settings.')
    try {
      return (await Notifications.getExpoPushTokenAsync({ projectId: projectId() })).data
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      throw new Error(
        /fcm|firebase|google/i.test(text)
          ? 'This build was made without Firebase (google-services.json), so Android cannot receive push alerts. Use an ntfy topic on the host instead.'
          : `Could not get a push token: ${text}`,
      )
    }
  })()
  // A failure is not remembered, so turning alerts on again tries again.
  token.catch(() => (token = undefined))
  return token
}

/** Tells a host to push this phone's alerts (or stop), as chosen. */
export async function applyHostAlerts(hostKey: string, prefs: HostAlertPrefs) {
  const t = await pushToken()
  if (!prefs.enabled) {
    await hostRequest(hostKey, 'push.unregister', { token: t })
    return
  }
  await hostRequest(hostKey, 'push.register', {
    token: t,
    deviceName: Device.deviceName ?? Device.modelName ?? undefined,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    events: prefs.events,
  })
}

let wired = false

/**
 * Shows alerts that arrive while the app is open, opens the session when one is tapped (also from a
 * cold start), and re-registers with each host as it connects so the host's copy stays current.
 */
export function startPush() {
  const Notifications = notifications()
  if (wired || Platform.OS === 'web' || !Notifications) return
  wired = true
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  })
  const open = (response: NotificationsModule.NotificationResponse | null) => {
    const id = sessionOfAlert(response?.notification.request.content.data)
    if (id) router.push({ pathname: '/session/[id]', params: { id } })
  }
  void Notifications.getLastNotificationResponseAsync().then(open)
  Notifications.addNotificationResponseReceivedListener(open)

  const registered = new Set<string>()
  const sync = () => {
    const { runtimes } = useHostStore.getState()
    const { hosts } = usePushPrefs.getState()
    for (const [hostKey, prefs] of Object.entries(hosts)) {
      const epoch = `${hostKey}:${runtimes[hostKey]?.epoch ?? 0}`
      if (!prefs.enabled || runtimes[hostKey]?.connection !== 'connected' || registered.has(epoch))
        continue
      registered.add(epoch)
      void applyHostAlerts(hostKey, prefs).catch(() => registered.delete(epoch))
    }
  }
  useHostStore.subscribe(sync)
  usePushPrefs.persist.onFinishHydration(sync)
  sync()
}
