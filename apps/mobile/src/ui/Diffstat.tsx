import { colors } from '@/theme/tokens'
import { Text } from './Text'

/** "+69 −8" in the desktop's green and red. Nothing when there are no changes. */
export function Diffstat({
  added,
  removed,
  size = 12,
}: {
  added: number
  removed: number
  size?: number
}) {
  if (added === 0 && removed === 0) return null
  return (
    <Text size={size}>
      <Text size={size} color={colors.success}>
        +{added}
      </Text>
      <Text size={size}> </Text>
      <Text size={size} color={colors.danger}>
        −{removed}
      </Text>
    </Text>
  )
}
