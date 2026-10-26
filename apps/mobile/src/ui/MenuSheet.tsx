import type { Icon as PhosphorIcon } from 'phosphor-react-native'
import { Check } from 'phosphor-react-native'
import { ScrollView, StyleSheet, View } from 'react-native'

import { colors, radius } from '@/theme/tokens'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { Sheet } from './Sheet'
import { Faint, Text } from './Text'

export interface MenuItem {
  id: string
  label: string
  hint?: string
  icon?: PhosphorIcon
  disabled?: boolean
  danger?: boolean
  selected?: boolean
  onSelect(): void
}

/** A list of choices in a floating panel, the phone's version of the desktop's menus. */
export function MenuSheet({
  visible,
  title,
  items,
  onClose,
  closeOnSelect = true,
}: {
  visible: boolean
  title?: string
  items: MenuItem[]
  onClose(): void
  /** False when choosing an item opens another step; the item then closes things itself. */
  closeOnSelect?: boolean
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      {title ? (
        <Faint size={12} weight="medium" numberOfLines={1} style={styles.title}>
          {title}
        </Faint>
      ) : null}
      <ScrollView bounces={false} style={{ flexGrow: 0 }}>
        {items.map((item, index) => (
          <PressableScale
            scaleTo={0.98}
            // Ids come from the agents (two of them may share one), so the position is part of the key.
            key={`${index}:${item.id}`}
            disabled={item.disabled}
            onPress={() => {
              if (closeOnSelect) onClose()
              item.onSelect()
            }}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? colors.hover : 'transparent' },
              item.disabled && { opacity: 0.45 },
            ]}
          >
            {item.icon ? (
              <Icon
                icon={item.icon}
                size={19}
                color={item.danger ? colors.danger : colors.textSecondary}
              />
            ) : null}
            <View style={{ flex: 1 }}>
              <Text size={14.5} color={item.danger ? colors.danger : colors.text}>
                {item.label}
              </Text>
              {item.hint ? <Faint size={12}>{item.hint}</Faint> : null}
            </View>
            {item.selected ? <Icon icon={Check} size={16} color={colors.textSecondary} /> : null}
          </PressableScale>
        ))}
      </ScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  title: { paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderRadius: radius.control + 2,
  },
})
