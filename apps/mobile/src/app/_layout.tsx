import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular'
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium'
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { DarkTheme, Stack as NativeStack, ThemeProvider } from 'expo-router'
import { Stack as JSStack } from 'expo-router/js-stack'
import { useFonts } from 'expo-font'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import '@/host/randomSource'
import { startPush } from '@/host/push'
import { startHosts, useHostStore } from '@/host/store'
import { colors } from '@/theme/tokens'
import { LoadingScreen } from '@/ui/LoadingScreen'

SplashScreen.preventAutoHideAsync()

// One object for good: a fresh one per render would make the navigator reconsider every screen.
// iOS keeps the native stack, whose swipe back already follows the finger.
const nativeOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: colors.panel },
  animation: 'slide_from_right',
  animationDuration: 240,
  // Swipe back from anywhere on the screen, not just its edge (iOS).
  fullScreenGestureEnabled: true,
} as const

// Android's native stack only reacts once the system back gesture is let go. This one is drawn by
// the app, so the screen follows the finger from the left edge. The first stretch of the edge
// belongs to the system's own back gesture, so this one starts a little further in.
const androidOptions = {
  headerShown: false,
  cardStyle: { backgroundColor: colors.panel },
  animation: 'slide_from_right',
  gestureEnabled: true,
  gestureResponseDistance: 80,
  gestureVelocityImpact: 0.3,
} as const

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.panel,
    card: colors.panel,
    border: colors.border,
    text: colors.text,
    primary: colors.accent,
  },
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_400Regular,
  })

  useEffect(() => {
    void startHosts()
    startPush()
  }, [])

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hide()
  }, [fontsLoaded])

  // The loading screen stays until the saved hosts are read and one answers (or a few seconds pass),
  // and never flashes by faster than its animation can be seen.
  const [minimumShown, setMinimumShown] = useState(false)
  const [gaveUp, setGaveUp] = useState(false)
  const [gone, setGone] = useState(false)
  // Each of these is a plain value, so this layout (the root of everything) is not redrawn for every
  // update a host streams, only when one of them actually changes.
  const ready = useHostStore((s) => s.ready)
  const hasHosts = useHostStore((s) => s.entries.length > 0)
  const anyConnected = useHostStore((s) =>
    s.entries.some((e) => s.runtimes[e.key]?.connection === 'connected'),
  )
  // A saved copy of the history is already on screen, so there is nothing to wait for.
  const anyRestored = useHostStore((s) =>
    s.entries.some((e) => (s.runtimes[e.key]?.replica.order.length ?? 0) > 0),
  )
  const waitingName = useHostStore((s) => {
    const waiting = s.entries.find((e) => s.runtimes[e.key]?.connection !== 'connected')
    return waiting ? (s.runtimes[waiting.key]?.host?.name ?? waiting.name) : undefined
  })
  useEffect(() => {
    if (!fontsLoaded) return
    const short = setTimeout(() => setMinimumShown(true), 450)
    const long = setTimeout(() => setGaveUp(true), 2000)
    return () => {
      clearTimeout(short)
      clearTimeout(long)
    }
  }, [fontsLoaded])
  const done = minimumShown && ready && (!hasHosts || anyConnected || anyRestored || gaveUp)
  const onGone = useCallback(() => setGone(true), [])
  const status = !ready
    ? 'Opening…'
    : waitingName
      ? `Connecting to ${waitingName}…`
      : hasHosts
        ? 'Ready'
        : 'Getting things ready…'

  if (!fontsLoaded) return null

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.panel }}>
      <SafeAreaProvider>
        <ThemeProvider value={theme}>
          <StatusBar style="light" />
          {Platform.OS === 'android' ? (
            <JSStack screenOptions={androidOptions} />
          ) : (
            <NativeStack screenOptions={nativeOptions} />
          )}
          {gone ? null : <LoadingScreen status={status} done={done} onGone={onGone} />}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
