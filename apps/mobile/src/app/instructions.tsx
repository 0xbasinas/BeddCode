import { folderName } from '@beddcode/client-runtime'
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { hostRequest, refreshProjects, useRuntime } from '@/host/store'
import { colors, fonts, radius } from '@/theme/tokens'
import { Header } from '@/ui/Header'
import { Screen } from '@/ui/Screen'
import { Muted, Text } from '@/ui/Text'

/** Project instructions stored on the host for this folder, shown to agents in later turns. */
export default function InstructionsScreen() {
  const { host, path } = useLocalSearchParams<{ host: string; path: string }>()
  const runtime = useRuntime(host)
  const project = runtime.projects.find((p) => p.path === path)
  const [text, setText] = useState(project?.instructions ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setText(project?.instructions ?? '')
  }, [project?.instructions, path])

  const save = async () => {
    if (!host || !path) return
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      await hostRequest(host, 'projects.setInstructions', { path, instructions: text })
      await refreshProjects(host)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <Header
        title="Project instructions"
        subtitle={project?.name || (path ? folderName(path) : 'Folder')}
      />
      <View style={styles.body}>
        <Muted size={12.5}>
          Saved on the host and included when an agent starts work in this folder.
        </Muted>
        <TextInput
          value={text}
          onChangeText={(v) => {
            setText(v)
            setSaved(false)
          }}
          multiline
          textAlignVertical="top"
          placeholder="Anything the agent should always know about this project…"
          placeholderTextColor={colors.faint}
          style={styles.input}
        />
        {error ? (
          <Text size={13} color={colors.danger}>
            {error}
          </Text>
        ) : saved ? (
          <Muted size={12.5}>Saved.</Muted>
        ) : null}
        <Pressable onPress={() => void save()} disabled={busy} style={styles.btn}>
          <Text size={14}>{busy ? 'Saving…' : 'Save'}</Text>
        </Pressable>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, padding: 16, gap: 12 },
  input: {
    flex: 1,
    minHeight: 180,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
    padding: 12,
  },
  btn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.hover,
    borderRadius: radius.control,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
})
