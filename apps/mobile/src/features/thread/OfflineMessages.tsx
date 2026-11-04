import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import {
  cancelQueuedMessage,
  editQueuedMessage,
  pauseQueuedMessage,
  useOfflineQueue,
} from '@/host/offlineQueue'
import { colors, fonts, radius } from '@/theme/tokens'
import { Text } from '@/ui/Text'
import type { QueuedMessage } from '@/host/offlineQueueCore'

function Row({ item }: { item: QueuedMessage }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)
  const [error, setError] = useState<string>()
  const status =
    item.state === 'review'
      ? 'Session changed. Review this message before sending.'
      : item.state === 'uncertain'
        ? 'Send status unknown. Check the conversation before removing this message.'
        : item.state === 'sending'
          ? 'Sending…'
          : 'Queued, will send when connected'
  const run = (action: () => Promise<void>) =>
    void action().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  return (
    <View style={styles.row}>
      <Text size={12} color={colors.muted}>
        {status}
      </Text>
      {editing ? (
        <TextInput
          multiline
          value={text}
          onChangeText={setText}
          style={styles.input}
          accessibilityLabel="Edit queued message"
        />
      ) : (
        <Text size={13}>{item.text}</Text>
      )}
      {item.attachments.length > 0 && (
        <Text size={12} color={colors.muted}>
          {item.attachments.length} attachment(s)
        </Text>
      )}
      <View style={styles.actions}>
        {item.state !== 'sending' &&
          item.state !== 'uncertain' &&
          (editing ? (
            <Pressable
              onPress={() =>
                run(async () => {
                  await editQueuedMessage(item.id, text)
                  setEditing(false)
                })
              }
            >
              <Text size={12}>Save</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() =>
                run(async () => {
                  await pauseQueuedMessage(item.id)
                  setEditing(true)
                })
              }
            >
              <Text size={12}>{item.state === 'review' ? 'Review and edit' : 'Edit'}</Text>
            </Pressable>
          ))}
        {item.state !== 'sending' && (
          <Pressable onPress={() => run(() => cancelQueuedMessage(item.id))}>
            <Text size={12}>Remove</Text>
          </Pressable>
        )}
      </View>
      {error && (
        <Text size={12} color={colors.danger}>
          {error}
        </Text>
      )}
    </View>
  )
}

export function OfflineMessages({ sessionId }: { sessionId: string }) {
  const items = useOfflineQueue((s) => s.items)
  const matching = items.filter((item) => item.sessionId === sessionId)
  if (!matching.length) return null
  return (
    <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
      {matching.map((item) => (
        <Row key={item.id} item={item} />
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  list: { maxHeight: 220, paddingHorizontal: 12 },
  row: {
    backgroundColor: colors.raised,
    borderRadius: radius.control,
    padding: 10,
    marginBottom: 6,
    gap: 6,
  },
  actions: { flexDirection: 'row', gap: 20 },
  input: { color: colors.text, fontFamily: fonts.regular, minHeight: 36 },
})
