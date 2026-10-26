import { useEffect, useRef, type ReactNode } from 'react'
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native'

/** Fades and eases its content up a few pixels when it first appears. */
export function FadeIn({
  children,
  delay = 0,
  distance = 8,
  enabled = true,
  style,
}: {
  children: ReactNode
  delay?: number
  distance?: number
  /** False shows the content as it is, with no entrance (decided once, when it first appears). */
  enabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const play = useRef(enabled).current
  const progress = useRef(new Animated.Value(play ? 0 : 1)).current
  useEffect(() => {
    if (!play) return
    Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [progress, delay, play])
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  )
}
