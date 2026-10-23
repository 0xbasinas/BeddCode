import type { ReactNode } from 'react'
import {
  KeyboardAvoidingView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { colors } from '@/theme/tokens'
import { useKeyboardVisible } from './useKeyboardVisible'

/**
 * A full screen on the desktop's panel colour, clear of the status bar and the home indicator.
 * Everything in it lifts above the keyboard, so inputs are never hidden behind it. (Android draws
 * edge to edge now, so it no longer resizes the window by itself.)
 */
export function Screen({
  children,
  bottom = true,
  style,
}: {
  children: ReactNode
  bottom?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardVisible()
  return (
    <View
      style={[
        styles.root,
        // The home indicator is behind the keyboard while it is up, so its space is not needed.
        { paddingTop: insets.top, paddingBottom: bottom && !keyboard ? insets.bottom : 0 },
        style,
      ]}
    >
      <KeyboardAvoidingView behavior="padding" style={styles.root}>
        {children}
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.panel },
})
