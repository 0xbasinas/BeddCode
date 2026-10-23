import type { Icon as PhosphorIcon } from 'phosphor-react-native'

import { colors } from '@/theme/tokens'

/** Draws a Phosphor line icon (the set the designs use) at the app's default size and colour. */
export function Icon({
  icon: Glyph,
  size = 18,
  color = colors.muted,
  weight = 'regular',
}: {
  icon: PhosphorIcon
  size?: number
  color?: string
  weight?: 'regular' | 'fill' | 'bold'
}) {
  return <Glyph size={size} color={color} weight={weight} />
}
