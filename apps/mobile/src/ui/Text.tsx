import { Text as RNText, type TextProps, type TextStyle } from 'react-native'

import { colors, fonts } from '@/theme/tokens'

type Weight = 'regular' | 'medium' | 'semibold'

interface Props extends TextProps {
  size?: number
  weight?: Weight
  color?: string
  mono?: boolean
}

/** Text in the app's fonts and the desktop's quiet palette. */
export function Text({
  size = 14,
  weight = 'regular',
  color = colors.text,
  mono,
  style,
  ...rest
}: Props) {
  const base: TextStyle = {
    fontFamily: mono ? fonts.mono : fonts[weight],
    fontSize: size,
    color,
  }
  return <RNText {...rest} style={[base, style]} />
}

export const Muted = (props: Props) => <Text color={colors.muted} {...props} />
export const Faint = (props: Props) => <Text color={colors.faint} {...props} />
