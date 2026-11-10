import type { SharedSettings } from '@beddcode/contracts'
import { Gear, ShieldCheck } from 'phosphor-react-native'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { updateHostSettings, useHostSettings } from '@/host/hostSettings'
import { colors, radius } from '@/theme/tokens'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'

const REVIEW: { id: NonNullable<SharedSettings['autoReview']>; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Use each agent’s own permission mode' },
  { id: 'ask', label: 'Ask', hint: 'New work waits for your approval' },
  { id: 'auto', label: 'Auto', hint: 'The host approves routine work on its own' },
]

const THEMES: { id: NonNullable<SharedSettings['theme']>; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

/**
 * Shared host settings the phone can change. They save on the host and show up live
 * on the desktop and web apps. This phone itself stays dark.
 */
export function SharedHostSettings({ hostKey, online }: { hostKey: string; online: boolean }) {
  const record = useHostSettings((s) => s.records[hostKey])
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const autoReview = record?.settings.autoReview ?? 'off'
  const theme = record?.settings.theme ?? 'dark'

  const save = async (patch: Parameters<typeof updateHostSettings>[1]) => {
    if (!online) return
    setBusy(true)
    setProblem(undefined)
    try {
      await updateHostSettings(hostKey, patch)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Icon icon={ShieldCheck} size={18} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={13.5}>Approval mode</Text>
          <Faint size={11.5}>Saved on this host and shown on every connected app.</Faint>
        </View>
      </View>
      <View style={styles.chips}>
        {REVIEW.map((m) => (
          <Chip
            key={m.id}
            label={m.label}
            hint={m.hint}
            selected={autoReview === m.id}
            disabled={!online || busy}
            onPress={() => void save({ autoReview: m.id })}
          />
        ))}
      </View>
      <View style={styles.head}>
        <Icon icon={Gear} size={18} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={13.5}>Theme for desktop and web</Text>
          <Faint size={11.5}>This phone stays dark. The other apps follow this choice.</Faint>
        </View>
      </View>
      <View style={styles.chips}>
        {THEMES.map((m) => (
          <Chip
            key={m.id}
            label={m.label}
            selected={theme === m.id}
            disabled={!online || busy}
            onPress={() => void save({ theme: m.id })}
          />
        ))}
      </View>
      {problem ? (
        <Muted size={12} style={styles.pad}>
          {problem}
        </Muted>
      ) : null}
    </View>
  )
}

function Chip({
  label,
  hint,
  selected,
  disabled,
  onPress,
}: {
  label: string
  hint?: string
  selected: boolean
  disabled?: boolean
  onPress(): void
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.chip, selected && styles.chipOn, disabled && styles.chipDisabled]}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
    >
      <Text size={12.5} color={selected ? colors.text : colors.textSecondary}>
        {label}
      </Text>
      {hint ? (
        <Faint size={10.5} numberOfLines={2}>
          {hint}
        </Faint>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  block: { paddingTop: 8, paddingBottom: 4, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingTop: 8 },
  pad: { paddingHorizontal: 14, paddingBottom: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, paddingBottom: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
    borderRadius: radius.panel,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxWidth: 220,
    gap: 2,
  },
  chipOn: { borderColor: colors.textSecondary, backgroundColor: colors.card },
  chipDisabled: { opacity: 0.45 },
})
