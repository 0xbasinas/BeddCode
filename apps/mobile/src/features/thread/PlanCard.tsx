import { CaretDown, CaretRight, CheckCircle, CircleDashed, CircleIcon, ListChecks } from 'phosphor-react-native'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import type { SessionView } from '@beddcode/client-runtime'

import { colors, radius } from '@/theme/tokens'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'

type Plan = NonNullable<SessionView['plan']>

const ICONS = {
  completed: CheckCircle,
  'in-progress': CircleDashed,
  pending: CircleIcon,
} as const

/** The agent's own to-do list, kept above the composer while the work is under way. */
export function PlanCard({ plan }: { plan: Plan }) {
  const done = plan.steps.filter((s) => s.status === 'completed').length
  const finished = done === plan.steps.length
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  const shown = open ?? !finished
  if (plan.steps.length === 0) return null
  return (
    <View style={styles.card}>
      <Pressable
        style={styles.head}
        onPress={() => setOpen(!shown)}
        accessibilityRole="button"
        accessibilityState={{ expanded: shown }}
        accessibilityLabel="Plan"
      >
        <Icon icon={ListChecks} size={16} />
        <Text size={13.5} style={{ flex: 1 }}>
          Plan <Faint size={12.5}>· {done} of {plan.steps.length} done</Faint>
        </Text>
        <Icon icon={shown ? CaretDown : CaretRight} size={14} />
      </Pressable>
      {shown ? (
        <View style={styles.steps}>
          {plan.explanation ? <Muted size={12.5}>{plan.explanation}</Muted> : null}
          {plan.steps.map((step, i) => (
            <View key={i} style={styles.step}>
              <Icon
                icon={ICONS[step.status]}
                size={14}
                color={step.status === 'completed' ? colors.success : colors.muted}
                weight={step.status === 'completed' ? 'fill' : 'regular'}
              />
              <Text size={13} style={{ flex: 1, opacity: step.status === 'completed' ? 0.7 : 1 }}>
                {step.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.control,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  steps: { paddingHorizontal: 12, paddingBottom: 10, gap: 6 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
})
