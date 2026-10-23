import { router } from 'expo-router'
import { CaretLeft } from 'phosphor-react-native'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { colors } from '@/theme/tokens'
import { Icon } from './Icon'
import { Muted, Text } from './Text'

/** The header row of a pushed screen: back, a title with an optional second line, actions. */
export function Header({
  title,
  subtitle,
  right,
  back = true,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
  back?: boolean
}) {
  return (
    <View style={styles.row}>
      {back && (
        <Pressable
          accessibilityLabel="Back"
          hitSlop={10}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={styles.back}
        >
          <Icon icon={CaretLeft} size={20} />
        </Pressable>
      )}
      <View style={styles.titles}>
        <Text size={14.5} weight="medium" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Muted size={12} numberOfLines={1}>
            {subtitle}
          </Muted>
        ) : null}
      </View>
      {right}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  back: { padding: 2 },
  titles: { flex: 1, gap: 2 },
})
