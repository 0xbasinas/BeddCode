import { emptyReplica } from '@beddcode/client-runtime'
import { PROTOCOL_VERSION } from '@beddcode/contracts'
import { StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'

export default function HomeScreen() {
  const sessions = emptyReplica().order.length

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="title" style={styles.title}>
          BeddCode
        </ThemedText>
        <ThemedText type="small">
          Protocol {PROTOCOL_VERSION} · {sessions} sessions
        </ThemedText>
      </SafeAreaView>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  title: {
    textAlign: 'center',
  },
})
