import { useRef } from 'react'
import {
  Animated,
  Pressable,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

type Style = StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>)

/**
 * A Pressable that dips a little under the finger and springs back, on the native thread, so
 * taps feel physical even while the JavaScript side is busy.
 */
export function PressableScale({
  scaleTo = 0.97,
  style,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, 'style'> & { scaleTo?: number; style?: Style }) {
  const scale = useRef(new Animated.Value(1)).current
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        Animated.timing(scale, { toValue: scaleTo, duration: 70, useNativeDriver: true }).start()
        onPressIn?.(e)
      }}
      onPressOut={(e) => {
        Animated.spring(scale, {
          toValue: 1,
          speed: 40,
          bounciness: 7,
          useNativeDriver: true,
        }).start()
        onPressOut?.(e)
      }}
      style={(state) => [
        typeof style === 'function' ? style(state) : style,
        { transform: [{ scale }] },
      ]}
    />
  )
}
