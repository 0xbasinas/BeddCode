import { folderName } from '@beddcode/client-runtime'
import type { HandoffMode, HandoffPolicy } from '@beddcode/client-runtime'
import { ArrowsDownUp, ArrowUp, Minus, Plus } from 'phosphor-react-native'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { defaultHandoffPolicy, useAutoHandoff } from '@/host/autoHandoff'
import { useRuntime } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'

const MODES: { id: HandoffMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Do not switch automatically' },
  { id: 'ask', label: 'Ask first', hint: 'A ten-second countdown, then switch' },
  { id: 'auto', label: 'Automatic', hint: 'Switch as soon as a turn fails that way' },
]

/**
 * When a turn fails in a way another agent can continue, the phone can start that handoff
 * while this app is open.
 */
export function AutoHandoffSettings({ hostKey }: { hostKey: string }) {
  const runtime = useRuntime(hostKey)
  const [project, setProject] = useState('')
  const host = useAutoHandoff((s) => s.hosts[hostKey])
  const update = useAutoHandoff((s) => s.setPolicy)
  const policy =
    (project ? host?.projects[project] : host?.global) ?? host?.global ?? defaultHandoffPolicy
  const save = (next: HandoffPolicy) => update(hostKey, project, next)
  const unused = runtime.providers.filter((p) => p.status === 'ready' && !policy.fallback.includes(p.id))

  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Icon icon={ArrowsDownUp} size={18} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={13.5}>Automatic handoff</Text>
          <Faint size={11.5}>Runs while this phone app is open.</Faint>
        </View>
      </View>
      <Text size={12} color={colors.textSecondary} style={styles.pad}>
        Scope
      </Text>
      <View style={styles.chips}>
        <Chip label="All projects" selected={!project} onPress={() => setProject('')} />
        {runtime.projects.map((p) => (
          <Chip
            key={p.path}
            label={p.name || folderName(p.path)}
            selected={project === p.path}
            onPress={() => setProject(p.path)}
          />
        ))}
      </View>
      <Text size={12} color={colors.textSecondary} style={styles.pad}>
        Mode
      </Text>
      <View style={styles.chips}>
        {MODES.map((m) => (
          <Chip
            key={m.id}
            label={m.label}
            hint={m.hint}
            selected={policy.mode === m.id}
            onPress={() => save({ ...policy, mode: m.id })}
          />
        ))}
      </View>
      <Text size={12} color={colors.textSecondary} style={styles.pad}>
        Fallback order (first available is used)
      </Text>
      {policy.fallback.length === 0 ? (
        <Muted size={12.5} style={styles.pad}>
          Add an agent the phone can switch to.
        </Muted>
      ) : (
        policy.fallback.map((id, i) => {
          const label = runtime.providers.find((p) => p.id === id)?.label ?? id
          return (
            <View key={id} style={styles.fallback}>
              <Text size={13.5} style={{ flex: 1 }} numberOfLines={1}>
                {i + 1}. {label}
              </Text>
              <Pressable
                hitSlop={8}
                disabled={i === 0}
                onPress={() => {
                  const next = [...policy.fallback]
                  ;[next[i - 1], next[i]] = [next[i]!, next[i - 1]!]
                  save({ ...policy, fallback: next })
                }}
                accessibilityLabel="Move up"
                style={i === 0 ? { opacity: 0.35 } : undefined}
              >
                <Icon icon={ArrowUp} size={14} />
              </Pressable>
              <Pressable
                hitSlop={8}
                onPress={() =>
                  save({ ...policy, fallback: policy.fallback.filter((p) => p !== id) })
                }
                accessibilityLabel={`Remove ${label}`}
              >
                <Icon icon={Minus} size={14} />
              </Pressable>
            </View>
          )
        })
      )}
      {unused.length > 0 ? (
        <View style={[styles.chips, { paddingBottom: 10 }]}>
          {unused.map((p) => (
            <Pressable
              key={p.id}
              style={styles.add}
              onPress={() => save({ ...policy, fallback: [...policy.fallback, p.id] })}
              accessibilityLabel={`Add ${p.label}`}
            >
              <Icon icon={Plus} size={12} />
              <Text size={12.5} color={colors.textSecondary}>
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function Chip({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string
  hint?: string
  selected: boolean
  onPress(): void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, selected && styles.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text size={12.5} color={selected ? colors.text : colors.textSecondary}>
        {label}
      </Text>
      {hint && selected ? <Faint size={11}>{hint}</Faint> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  block: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  pad: { paddingHorizontal: 14, paddingBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 14, paddingBottom: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.active },
  fallback: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
})
