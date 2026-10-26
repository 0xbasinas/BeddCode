import { useRef, useState } from 'react'
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
  const [pressed, setPressed] = useState(false)
  // Animated ignores a style that is a function, which would leave `scale` an unwired value on a
  // plain view (and the button invisible). So the function is resolved here, to an ordinary style.
  const resolved = typeof style === 'function' ? style({ pressed, hovered: false }) : style
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        setPressed(true)
        Animated.timing(scale, { toValue: scaleTo, duration: 70, useNativeDriver: true }).start()
        onPressIn?.(e)
      }}
      onPressOut={(e) => {
        setPressed(false)
        Animated.spring(scale, {
          toValue: 1,
          speed: 40,
          bounciness: 7,
          useNativeDriver: true,
        }).start()
        onPressOut?.(e)
      }}
      style={[resolved, { transform: [{ scale }] }]}
    />
  )
}
