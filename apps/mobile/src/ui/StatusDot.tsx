import { Check } from 'phosphor-react-native'
import { StyleSheet, View } from 'react-native'
import type { SessionView } from '@beddcode/client-runtime'

import { colors } from '@/theme/tokens'
import { Icon } from './Icon'

/** The marker in front of a session: amber waiting on you, ring for failed, a check when finished. */
export function StatusDot({ session }: { session: SessionView }) {
  const finished =
    session.status === 'idle' && session.items.length > 0 && session.lastTurnReason !== 'cancelled'
  if (finished) return <Icon icon={Check} size={13} color={colors.muted} />
  if (session.status === 'failed')
    return <View style={[styles.ring, { borderColor: colors.danger }]} />
  const color =
    session.status === 'needs-you'
      ? colors.accent
      : session.status === 'running'
        ? colors.muted
        : colors.faint
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

const styles = StyleSheet.create({
  dot: { width: 6, height: 6, borderRadius: 3 },
  ring: { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
})
