import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular'
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium'
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { DarkTheme, Stack, ThemeProvider } from 'expo-router'
import { useFonts } from 'expo-font'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import '@/host/randomSource'
import { startPush } from '@/host/push'
import { startHosts, useHostStore } from '@/host/store'
import { colors } from '@/theme/tokens'
import { LoadingScreen } from '@/ui/LoadingScreen'

SplashScreen.preventAutoHideAsync()

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
  const ready = useHostStore((s) => s.ready)
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const anyConnected = entries.some((e) => runtimes[e.key]?.connection === 'connected')
  useEffect(() => {
    if (!fontsLoaded) return
    const short = setTimeout(() => setMinimumShown(true), 900)
    const long = setTimeout(() => setGaveUp(true), 5000)
    return () => {
      clearTimeout(short)
      clearTimeout(long)
    }
  }, [fontsLoaded])
  const done = minimumShown && ready && (entries.length === 0 || anyConnected || gaveUp)
  const onGone = useCallback(() => setGone(true), [])
  const waitingFor = entries.find((e) => runtimes[e.key]?.connection !== 'connected')
  const status = !ready
    ? 'Opening…'
    : waitingFor
      ? `Connecting to ${runtimes[waitingFor.key]?.host?.name ?? waitingFor.name}…`
      : entries.length > 0
        ? 'Ready'
        : 'Getting things ready…'

  if (!fontsLoaded) return null

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.panel }}>
      <SafeAreaProvider>
        <ThemeProvider value={theme}>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.panel },
              animation: 'slide_from_right',
            }}
          />
          {gone ? null : <LoadingScreen status={status} done={done} onGone={onGone} />}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
