import { useState } from 'react'
import { TextInput, View } from 'react-native'
import type { SessionView } from '@beddcode/client-runtime'
import { hostRequest, dequeue } from '@/host/store'
import { Button } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { colors } from '@/theme/tokens'

export function QueueControls({ session, hostKey }: { session: SessionView; hostKey: string }) {
  const [edit, setEdit] = useState<{ id: string; text: string; original: string }>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (action: () => Promise<unknown>) => {
    setPending(true)
    setError(undefined)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }
  return (
    <View style={{ gap: 8, paddingHorizontal: 16 }}>
      {session.queue.map((q, i) => (
        <View key={q.queueId} style={{ gap: 6 }}>
          <Text numberOfLines={2}>{q.text || q.attachments.map((a) => a.name).join(', ')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Button
              label="Edit"
              disabled={pending}
              onPress={() => setEdit({ id: q.queueId, text: q.text, original: q.text })}
            />
            <Button
              label="Move up"
              disabled={pending || i === 0}
              onPress={() =>
                void run(() =>
                  hostRequest(hostKey, 'sessions.queue.move', {
                    sessionId: session.id,
                    queueId: q.queueId,
                    direction: 'up',
                  }),
                )
              }
            />
            <Button
              label="Move down"
              disabled={pending || i === session.queue.length - 1}
              onPress={() =>
                void run(() =>
                  hostRequest(hostKey, 'sessions.queue.move', {
                    sessionId: session.id,
                    queueId: q.queueId,
                    direction: 'down',
                  }),
                )
              }
            />
            <Button
              label="Send now"
              disabled={pending}
              onPress={() => void run(() => dequeue(session.id, q.queueId, 'steer'))}
            />
            <Button
              label="Remove"
              disabled={pending}
              onPress={() => void run(() => dequeue(session.id, q.queueId, 'cancel'))}
            />
          </View>
          {edit?.id === q.queueId && (
            <View style={{ gap: 6 }}>
              <TextInput
                accessibilityLabel="Edit queued message"
                multiline
                value={edit.text}
                onChangeText={(text) => setEdit({ ...edit, text })}
                style={{
                  color: colors.text,
                  backgroundColor: colors.card,
                  padding: 12,
                  minHeight: 80,
                }}
              />
              <Button
                label="Save queued message"
                disabled={pending}
                onPress={() =>
                  void run(async () => {
                    await hostRequest(hostKey, 'sessions.queue.edit', {
                      sessionId: session.id,
                      queueId: q.queueId,
                      text: edit.text,
                      expectedText: edit.original,
                    })
                    setEdit(undefined)
                  })
                }
              />
              <Button label="Cancel edit" disabled={pending} onPress={() => setEdit(undefined)} />
            </View>
          )}
        </View>
      ))}
      {error && <Text color={colors.danger}>{error}</Text>}
    </View>
  )
}
