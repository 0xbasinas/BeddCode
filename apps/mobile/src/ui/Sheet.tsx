import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Animated, Easing, Modal, PanResponder, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { colors, radius } from '@/theme/tokens'
import { snap } from './haptics'

/**
 * A panel that floats above the screen like the desktop's menus: raised, bordered and shadowed,
 * with the screen behind it left as it is. A tap anywhere outside it closes it, and so does
 * dragging its handle down.
 */
const CLOSE_AFTER = 70
export function Sheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean
  onClose(): void
  children: ReactNode
}) {
  const insets = useSafeAreaInsets()
  // The modal stays up while the panel slides away, then goes.
  const [mounted, setMounted] = useState(visible)
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current
  // How far the finger has pulled the panel down, on top of its slide in and out.
  const drag = useRef(new Animated.Value(0)).current
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const pan = useRef(
    (() => {
      let past = false
      return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_e, g) => {
          drag.setValue(Math.max(0, g.dy))
          const over = g.dy > CLOSE_AFTER
          if (over !== past) snap()
          past = over
        },
        onPanResponderRelease: (_e, g) => {
          past = false
          if (g.dy > CLOSE_AFTER || g.vy > 0.9) onCloseRef.current()
          else Animated.spring(drag, { toValue: 0, bounciness: 6, useNativeDriver: true }).start()
        },
        onPanResponderTerminate: () => {
          past = false
          Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start()
        },
      })
    })(),
  ).current
  useEffect(() => {
    if (visible) {
      drag.setValue(0)
      setMounted(true)
      Animated.timing(progress, {
        toValue: 1,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start()
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: 160,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => finished && setMounted(false))
    }
  }, [visible, progress, drag])
  if (!mounted) return null
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.outside} onPress={onClose} accessibilityLabel="Close" />
      <View
        pointerEvents="box-none"
        style={[styles.anchor, { paddingBottom: Math.max(insets.bottom, 8) + 6 }]}
      >
        <Animated.View
          style={[
            styles.panel,
            {
              opacity: progress,
              transform: [
                {
                  translateY: Animated.add(
                    progress.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }),
                    drag,
                  ),
                },
                { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) },
              ],
            },
          ]}
        >
          <View style={styles.grab} {...pan.panHandlers} accessibilityLabel="Drag down to close">
            <View style={styles.grabBar} />
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  outside: StyleSheet.absoluteFill,
  grab: { alignItems: 'center', paddingTop: 4, paddingBottom: 8, marginTop: -4 },
  grabBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border },
  anchor: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 10 },
  panel: {
    backgroundColor: colors.card,
    borderRadius: radius.sheet + 2,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 8,
    gap: 4,
    // The shadow is what lifts it off the screen now that nothing is dimmed.
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 16,
    maxHeight: '80%',
  },
})
