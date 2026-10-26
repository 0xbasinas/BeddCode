import { Check } from 'phosphor-react-native'
import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import type { SessionView } from '@beddcode/client-runtime'

import { colors } from '@/theme/tokens'
import { Icon } from './Icon'

/** The marker in front of a session: amber waiting on you, ring for failed, a check when finished. */
export function StatusDot({ session }: { session: SessionView }) {
  const finished =
    session.status === 'idle' && session.items.length > 0 && session.lastTurnReason !== 'cancelled'
  if (finished) return <Icon icon={Check} size={13} color={colors.muted} />
  if (session.status === 'failed')
    return <View style={[styles.ring, { borderColor: colors.danger }]} />
  const color =
    session.status === 'needs-you'
      ? colors.accent
      : session.status === 'running'
        ? colors.muted
        : colors.faint
  if (session.status === 'running') return <Pulse color={color} />
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

/** A running session breathes, so a glance at the list shows what is working. */
function Pulse({ color }: { color: string }) {
  const level = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(level, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(level, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [level])
  return (
    <Animated.View
      style={[
        styles.dot,
        {
          backgroundColor: color,
          opacity: level.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
          transform: [
            { scale: level.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.25] }) },
          ],
        },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  dot: { width: 6, height: 6, borderRadius: 3 },
  ring: { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
})
