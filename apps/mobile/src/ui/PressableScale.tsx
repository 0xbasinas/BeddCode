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
 * taps feel physical even while the JavaScript side is busy. The dip (and the optional dimming)
 * is one native animation: touching it costs no React render. A style given as a function does
 * re-render on touch, since it reads `pressed`; use a plain style plus `dimTo` where you can.
 */
export function PressableScale({
  scaleTo = 0.97,
  dimTo,
  style,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, 'style'> & { scaleTo?: number; dimTo?: number; style?: Style }) {
  const press = useRef(new Animated.Value(0)).current
  const [pressed, setPressed] = useState(false)
  const reads = typeof style === 'function'
  // Animated ignores a style that is a function, which would leave the animated values unwired on
  // a plain view (and the button invisible). So the function is resolved here, to an ordinary style.
  const resolved = reads ? style({ pressed, hovered: false }) : style
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        Animated.timing(press, { toValue: 1, duration: 40, useNativeDriver: true }).start()
        if (reads) setPressed(true)
        onPressIn?.(e)
      }}
      onPressOut={(e) => {
        Animated.spring(press, {
          toValue: 0,
          speed: 40,
          bounciness: 7,
          useNativeDriver: true,
        }).start()
        if (reads) setPressed(false)
        onPressOut?.(e)
      }}
      style={[
        resolved,
        {
          transform: [
            { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, scaleTo] }) },
          ],
          ...(dimTo === undefined
            ? null
            : { opacity: press.interpolate({ inputRange: [0, 1], outputRange: [1, dimTo] }) }),
        },
      ]}
    />
  )
}
