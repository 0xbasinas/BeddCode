import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg'

import { colors } from '@/theme/tokens'
import { Logo } from './Logo'
import { Faint, Text } from './Text'

/**
 * Shown right after the native splash while the app reads its saved hosts and reaches them: the
 * same mark on the same dark background (so the hand-over is seamless), breathing gently, with a
 * line saying what it is waiting for. It fades away when `done` turns true.
 */
export function LoadingScreen({
  status,
  done,
  onGone,
}: {
  status: string
  done: boolean
  onGone(): void
}) {
  const breathe = useRef(new Animated.Value(0)).current
  const fade = useRef(new Animated.Value(1)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 0,
          duration: 1100,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [breathe])

  useEffect(() => {
    if (!done) return
    Animated.timing(fade, { toValue: 0, duration: 320, useNativeDriver: true }).start(onGone)
  }, [done, fade, onGone])

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] })
  const glow = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.6] })

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <View style={styles.markWrap}>
        <Animated.View style={[styles.glow, { opacity: glow, transform: [{ scale }] }]}>
          <Svg width={200} height={200}>
            <Defs>
              <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
                <Stop offset="0.35" stopColor={colors.accent} stopOpacity={1} />
                <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={100} cy={100} r={100} fill="url(#halo)" />
          </Svg>
        </Animated.View>
        <Animated.View style={{ transform: [{ scale }] }}>
          <Logo size={132} />
        </Animated.View>
      </View>
      <Text size={22} weight="semibold" style={styles.word}>
        BeddCode
      </Text>
      <View style={styles.footer}>
        <Faint size={12.5}>{status}</Faint>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.appBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The mark sits where the native splash drew it, so the hand-over does not move anything.
  word: { position: 'absolute', top: '50%', marginTop: 98, letterSpacing: 0.3 },
  markWrap: { width: 200, height: 200, alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute', width: 200, height: 200 },
  footer: { position: 'absolute', bottom: 56 },
})
