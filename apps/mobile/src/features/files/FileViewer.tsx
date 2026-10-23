import type { FileContent } from '@beddcode/contracts'
import * as Clipboard from 'expo-clipboard'
import { CaretLeft, FloppyDisk, PencilSimple, Paperclip } from 'phosphor-react-native'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'

import { attachText, attachWorkspaceFile } from '@/host/attachments'
import { hostHttpBase, hostRequest } from '@/host/store'
import { colors, fonts, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'
import { highlightLine } from './highlight'

interface Loaded {
  file?: FileContent
  media?: { url: string; kind: 'image' | 'video' | 'audio' }
  error?: string
}

const extensionOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? ''

/**
 * One file of the project: read it with line numbers, tap lines to pick a range and attach it to the
 * chat, or switch to editing. Images show as pictures; other binary files can still be attached.
 */
export function FileViewer({
  hostKey,
  sessionId,
  cwd,
  path,
  onClose,
  onAttached,
}: {
  hostKey: string
  sessionId: string
  cwd: string
  path: string
  onClose(): void
  onAttached(): void
}) {
  const [loaded, setLoaded] = useState<Loaded>()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [range, setRange] = useState<[number, number] | null>(null)
  const ext = extensionOf(path)

  const load = useCallback(async () => {
    try {
      const file = await hostRequest(hostKey, 'files.read', { cwd, path })
      if (file.binary || file.tooLarge) {
        const media = await hostRequest(hostKey, 'files.media', { cwd, path }).catch(() => null)
        setLoaded({ file, media: media ?? undefined })
      } else {
        setLoaded({ file })
      }
    } catch (err) {
      setLoaded({ error: err instanceof Error ? err.message : String(err) })
    }
  }, [hostKey, cwd, path])

  useEffect(() => {
    setLoaded(undefined)
    setEditing(false)
    setRange(null)
    void load()
  }, [load])

  const lines = useMemo(() => loaded?.file?.content.split('\n') ?? [], [loaded])

  const pick = (n: number) =>
    setRange((r) => {
      // First tap picks a line, the second extends to a range, a third starts over.
      if (!r) return [n, n]
      if (r[0] === r[1]) return n === r[0] ? null : [Math.min(r[0], n), Math.max(r[0], n)]
      return [n, n]
    })

  const selectedText = range ? lines.slice(range[0] - 1, range[1]).join('\n') : ''

  const attachRange = () => {
    if (!range) return
    const label = `${path}:${range[0]}${range[1] !== range[0] ? `-${range[1]}` : ''}`
    void attachText(hostKey, sessionId, label, `${label}\n\n${selectedText}`)
    setRange(null)
    onAttached()
  }

  const save = async () => {
    if (!loaded?.file) return
    setSaving(true)
    setSaveError(undefined)
    try {
      const result = await hostRequest(hostKey, 'files.write', {
        cwd,
        path,
        content: draft,
        expectedMtime: loaded.file.mtime,
      })
      setLoaded({
        file: { ...loaded.file, content: draft, mtime: result.mtime, size: draft.length },
      })
      setEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const name = path.split('/').pop() ?? path
  const dirty = editing && loaded?.file && draft !== loaded.file.content

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.head}>
        <Pressable hitSlop={10} onPress={onClose} accessibilityLabel="Back to files">
          <Icon icon={CaretLeft} size={20} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text size={14} weight="medium" numberOfLines={1}>
            {name}
          </Text>
          <Faint size={11.5} numberOfLines={1}>
            {path}
          </Faint>
        </View>
        {loaded?.file && !loaded.file.binary && !loaded.file.tooLarge ? (
          editing ? (
            <Pressable
              style={[styles.save, !dirty && { opacity: 0.5 }]}
              disabled={!dirty || saving}
              onPress={() => void save()}
            >
              <Icon icon={FloppyDisk} size={15} color={colors.onPrimary} />
              <Text size={12.5} weight="semibold" color={colors.onPrimary}>
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              hitSlop={8}
              onPress={() => {
                setDraft(loaded.file!.content)
                setEditing(true)
                setRange(null)
              }}
              accessibilityLabel="Edit"
            >
              <Icon icon={PencilSimple} size={19} />
            </Pressable>
          )
        ) : null}
      </View>

      {!loaded ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      ) : loaded.error ? (
        <View style={styles.center}>
          <Text size={13} color={colors.danger} style={{ textAlign: 'center' }}>
            {loaded.error}
          </Text>
        </View>
      ) : loaded.media?.kind === 'image' ? (
        <View style={styles.center}>
          <Image
            source={{ uri: `${hostHttpBase(hostKey) ?? ''}${loaded.media.url}` }}
            style={{ width: '100%', height: '70%' }}
            resizeMode="contain"
          />
          <View style={{ paddingTop: 12 }}>
            <Button
              label="Attach to chat"
              kind="primary"
              onPress={() => {
                void attachWorkspaceFile(hostKey, sessionId, cwd, path)
                onAttached()
              }}
            />
          </View>
        </View>
      ) : loaded.file?.binary || loaded.file?.tooLarge ? (
        <View style={styles.center}>
          <Muted size={13.5} style={{ textAlign: 'center' }}>
            {loaded.file.tooLarge
              ? 'This file is too large to open here.'
              : 'This is a binary file.'}
          </Muted>
          <View style={{ paddingTop: 12 }}>
            <Button
              label="Attach to chat"
              kind="primary"
              onPress={() => {
                void attachWorkspaceFile(hostKey, sessionId, cwd, path)
                onAttached()
              }}
            />
          </View>
        </View>
      ) : editing ? (
        <View style={{ flex: 1 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={styles.editor}
            textAlignVertical="top"
          />
          {saveError ? (
            <Text size={12} color={colors.danger} style={{ padding: 10 }}>
              {saveError}
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={lines}
          keyExtractor={(_, i) => String(i)}
          style={styles.code}
          initialNumToRender={40}
          windowSize={12}
          renderItem={({ item, index }) => {
            const n = index + 1
            const on = range ? n >= range[0] && n <= range[1] : false
            return (
              <Pressable
                style={[styles.line, on && { backgroundColor: colors.infoSoft }]}
                onPress={() => pick(n)}
              >
                <Text size={11} mono color={on ? colors.info : '#4a4a4a'} style={styles.gutter}>
                  {n}
                </Text>
                <Text size={11.5} mono>
                  {highlightLine(item, ext).map((s, i) => (
                    <Text key={i} size={11.5} mono color={s.color}>
                      {s.text}
                    </Text>
                  ))}
                  {item === '' ? ' ' : ''}
                </Text>
              </Pressable>
            )
          }}
        />
      )}

      {range && !editing ? (
        <View style={styles.selection}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon icon={Paperclip} size={15} color={colors.info} />
            <Text size={12} color={colors.info}>
              {range[0] === range[1]
                ? `Line ${range[0]} selected`
                : `Lines ${range[0]}–${range[1]} selected`}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              label="Copy"
              onPress={() => {
                void Clipboard.setStringAsync(selectedText)
                setRange(null)
              }}
              style={styles.small}
            />
            <Button
              label="Attach to chat"
              kind="primary"
              onPress={attachRange}
              style={styles.small}
            />
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  save: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  code: { flex: 1, backgroundColor: colors.code, paddingTop: 6 },
  line: { flexDirection: 'row', paddingRight: 12, minHeight: 20 },
  gutter: { width: 40, textAlign: 'right', paddingRight: 10, lineHeight: 20 },
  editor: {
    flex: 1,
    backgroundColor: colors.code,
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    padding: 12,
  },
  selection: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.raised,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  small: { minHeight: 36, paddingHorizontal: 12 },
})
