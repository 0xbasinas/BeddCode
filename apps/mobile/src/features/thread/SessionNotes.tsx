import { useState } from 'react'
import { TextInput, View } from 'react-native'
import type { SessionView } from '@beddcode/client-runtime'
import { hostRequest, useRuntime } from '@/host/store'
import { Button } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { colors } from '@/theme/tokens'

export function SessionNotes({ session, hostKey }: { session: SessionView; hostKey: string }) {
  const remote = session.notes ?? { text: '', version: 0 }
  const [base, setBase] = useState(remote)
  const [draft, setDraft] = useState(remote.text)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const { connection } = useRuntime(hostKey)
  const dirty = draft !== base.text
  const conflict = remote.version > base.version
  if (conflict && !dirty) {
    setBase(remote)
    setDraft(remote.text)
  }
  const save = async () => {
    setPending(true)
    setError(undefined)
    try {
      const saved = await hostRequest(hostKey, 'sessions.notes.set', {
        sessionId: session.id,
        text: draft,
        expectedVersion: base.version,
      })
      setBase(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }
  return (
    <View style={{ padding: 16, gap: 8 }}>
      <Text weight="semibold">Session notes</Text>
      <Text>
        {connection !== 'connected'
          ? 'Offline; keep this screen open to retain your draft'
          : dirty
            ? 'Unsaved draft'
            : 'Saved on host'}
      </Text>
      <TextInput
        accessibilityLabel="Session notes"
        multiline
        value={draft}
        onChangeText={setDraft}
        editable={!pending}
        maxLength={100_000}
        style={{
          color: colors.text,
          backgroundColor: colors.card,
          minHeight: 100,
          padding: 12,
          textAlignVertical: 'top',
        }}
      />
      {conflict && dirty && (
        <>
          <Text>Saved on another device: {remote.text}</Text>
          <Button
            label="Use latest notes"
            onPress={() => {
              setBase(remote)
              setDraft(remote.text)
            }}
          />
          <Button label="Keep my draft for another save" onPress={() => setBase(remote)} />
        </>
      )}
      <Button
        label={pending ? 'Saving…' : 'Save notes'}
        disabled={pending || !dirty || conflict || connection !== 'connected'}
        onPress={() => void save()}
      />
      {error && <Text color={colors.danger}>{error}</Text>}
    </View>
  )
}
