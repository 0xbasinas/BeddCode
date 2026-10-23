import { StyleSheet, View } from 'react-native'

import { colors } from '@/theme/tokens'
import { Text } from './Text'

/** A unified diff, line by line: additions green, removals red, hunk headers faint. */
export function PatchView({ patch, max = 80 }: { patch: string; max?: number }) {
  const lines = patch.split('\n').slice(0, max)
  return (
    <View style={styles.patch}>
      {lines.map((line, i) => {
        const add = line.startsWith('+') && !line.startsWith('+++')
        const del = line.startsWith('-') && !line.startsWith('---')
        const hunk = line.startsWith('@@')
        return (
          <Text
            key={i}
            size={10.5}
            mono
            color={add ? colors.success : del ? colors.danger : hunk ? colors.faint : colors.muted}
            style={[
              styles.patchLine,
              add && { backgroundColor: colors.successSoft },
              del && { backgroundColor: colors.dangerSoft },
            ]}
          >
            {line || ' '}
          </Text>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  patch: { backgroundColor: colors.terminal, paddingVertical: 4 },
  patchLine: { paddingHorizontal: 10, lineHeight: 16 },
})
