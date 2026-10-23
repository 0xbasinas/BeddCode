import type { ReactNode } from 'react'
import { Modal, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { colors, radius } from '@/theme/tokens'

/**
 * A panel that floats above the screen like the desktop's menus: raised, bordered and shadowed,
 * with the screen behind it left as it is. A tap anywhere outside it closes it.
 */
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
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.outside} onPress={onClose} accessibilityLabel="Close" />
      <View
        pointerEvents="box-none"
        style={[styles.anchor, { paddingBottom: Math.max(insets.bottom, 8) + 6 }]}
      >
        <View style={styles.panel}>{children}</View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  outside: StyleSheet.absoluteFill,
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
