import { useId } from 'react'
import Svg, { Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg'

/**
 * The BeddCode mark: a "B" made of two stacked windows on one stem, with a cursor in the first and
 * a prompt in the second, on an amber tile. The same drawing as assets/logo/mark.svg and the web
 * app's Logo, which the icon script renders.
 */
export function Logo({ size = 24 }: { size?: number }) {
  const id = useId()
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" accessibilityLabel="BeddCode">
      <Defs>
        <LinearGradient id={id} x1="30" y1="0" x2="226" y2="256" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#f8c46a" />
          <Stop offset="1" stopColor="#e08a1a" />
        </LinearGradient>
      </Defs>
      <Rect width="256" height="256" rx="60" fill={`url(#${id})`} />
      <G transform="translate(128 128) scale(1.08) translate(-128 -128)">
        <Path
          fill="#171717"
          d="M82 52 H134 A22 22 0 0 1 156 74 V94 A22 22 0 0 1 134 116 H108 V124 H160 A26 26 0 0 1 186 150 V178 A26 26 0 0 1 160 204 H82 A12 12 0 0 1 70 192 V64 A12 12 0 0 1 82 52 Z"
        />
        <Rect x="108" y="77" width="30" height="14" rx="7" fill="#f2ab3c" />
        <Path
          d="M114.5 150 L131.5 164 L114.5 178"
          fill="none"
          stroke="#f2ab3c"
          strokeWidth={13}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
    </Svg>
  )
}
