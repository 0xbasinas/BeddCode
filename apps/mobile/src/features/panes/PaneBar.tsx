import type { Icon as PhosphorIcon } from 'phosphor-react-native'
import { ChatCircle, FolderSimple, GitBranch, Globe, TerminalWindow } from 'phosphor-react-native'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { colors } from '@/theme/tokens'
import { Icon } from '@/ui/Icon'
import { Text } from '@/ui/Text'

export type Pane = 'thread' | 'terminal' | 'files' | 'git' | 'browser'

const PANES: { id: Pane; label: string; icon: PhosphorIcon }[] = [
  { id: 'thread', label: 'Thread', icon: ChatCircle },
  { id: 'terminal', label: 'Terminal', icon: TerminalWindow },
  { id: 'files', label: 'Files', icon: FolderSimple },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'browser', label: 'Browser', icon: Globe },
]

/**
 * The desktop's pane rail as a rounded bar floating at the bottom. The open pane is a pill with
 * its name; the others are just their icons.
 */
export function PaneBar({ pane, onChange }: { pane: Pane; onChange(pane: Pane): void }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <View style={styles.bar}>
        {PANES.map((p) => {
          const active = p.id === pane
          return (
            <Pressable
              key={p.id}
              onPress={() => onChange(p.id)}
              accessibilityLabel={p.label}
              accessibilityState={{ selected: active }}
              style={[styles.item, active && styles.active]}
            >
              <Icon
                icon={p.icon}
                size={20}
                color={active ? colors.text : colors.faint}
                weight={active ? 'fill' : 'regular'}
              />
              {active ? (
                <Text size={12.5} weight="medium" color={colors.text}>
                  {p.label}
                </Text>
              ) : null}
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 6, backgroundColor: colors.panel },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 5,
    backgroundColor: colors.card,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: colors.border,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 40,
    minWidth: 44,
    paddingHorizontal: 12,
    borderRadius: 20,
    justifyContent: 'center',
  },
  active: { backgroundColor: colors.active },
})
