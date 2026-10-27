import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'

import { colors, radius } from '@/theme/tokens'
import { tap } from './haptics'
import { PressableScale } from './PressableScale'
import { Text } from './Text'

/** Primary is the desktop's light button; secondary is the dark one beside it. */
export function Button({
  label,
  onPress,
  kind = 'secondary',
  disabled,
  style,
}: {
  label: string
  onPress?: () => void
  kind?: 'primary' | 'secondary'
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const primary = kind === 'primary'
  return (
    <PressableScale
      accessibilityRole="button"
      disabled={disabled}
      // The tick comes the moment the finger lands, not when it lifts.
      onPressIn={tap}
      onPress={onPress}
      dimTo={disabled ? undefined : 0.8}
      style={[
        styles.base,
        {
          backgroundColor: primary ? colors.primary : colors.hover,
          ...(disabled ? { opacity: 0.45 } : null),
        },
        style,
      ]}
    >
      <Text
        size={13.5}
        weight={primary ? 'semibold' : 'regular'}
        color={primary ? colors.onPrimary : colors.text}
        numberOfLines={1}
      >
        {label}
      </Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  base: {
    minHeight: 44,
    borderRadius: radius.control,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
