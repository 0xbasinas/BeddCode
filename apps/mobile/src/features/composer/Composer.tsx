import {
  ArrowUp,
  CaretDown,
  Paperclip,
  Plus,
  Shield,
  Sparkle,
  Stop,
  X,
} from 'phosphor-react-native'
import { useEffect, useState } from 'react'
import { insertCommand, insertMention, matchCommands, mentionAt } from '@beddcode/client-runtime'
import type { SlashCommand } from '@beddcode/contracts'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { EMPTY_ATTACHMENTS, type DraftAttachment } from '@/host/attachments'
import { colors, fonts, radius } from '@/theme/tokens'
import { AttachmentImage, isImageName } from './AttachmentImage'
import { matchingContextMentions, type ContextMentionKind } from './contextMentions'
import { resolveContextMention } from './resolveContextMention'
import { mentionItems, type MentionItem } from './mentionItems'
import { send as sendHaptic } from '@/ui/haptics'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'

export interface Chip {
  label: string
  detail?: string
  onPress?: () => void
}

/**
 * The message box of the desktop composer: a bordered field with the agent's mode and model under
 * it, and a round button that sends (or stops a running turn).
 */
export function Composer({
  placeholder,
  onSend,
  onStop,
  running,
  mode,
  model,
  onAttach,
  initial = '',
  autoFocus,
  context,
  attachments = EMPTY_ATTACHMENTS,
  onRemoveAttachment,
  hostKey,
  commands,
  onDraftChange,
  cwd,
}: {
  placeholder: string
  onSend(text: string, attachmentIds: string[]): Promise<void> | void
  onStop?: () => void
  running?: boolean
  mode?: Chip
  model?: Chip
  onAttach?: () => void
  initial?: string
  autoFocus?: boolean
  /** A short line under the field, e.g. the context window in use. */
  context?: string
  /** Files and snippets waiting to go out with this message. */
  attachments?: DraftAttachment[]
  onRemoveAttachment?: (key: number) => void
  /** The host the attachments live on, so images can be previewed. */
  hostKey?: string
  /** The agent's slash commands, offered while the message is a half-typed `/command`. */
  commands?: SlashCommand[]
  onDraftChange?(text: string): void
  /** The session folder, used to offer @file mentions and live @diff/@ci/@pr/@term. */
  cwd?: string
}) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const uploading = attachments.some((a) => a.status === 'uploading')
  const ready = attachments.filter((a) => a.status === 'done' && a.id).map((a) => a.id!)
  const canSend = text.trim().length > 0 && !busy && !uploading
  const [dismissed, setDismissed] = useState<string>()
  const matches = dismissed === text ? [] : matchCommands(text, commands)
  const [caret, setCaret] = useState(0)
  const [selection, setSelection] = useState<{ start: number; end: number }>()
  const mention = mentionAt(text, caret)
  const contextKinds = mention ? matchingContextMentions(mention.query) : []
  const [fileMentions, setFileMentions] = useState<MentionItem[]>([])
  const [mentionBusy, setMentionBusy] = useState(false)
  const showMentions = Boolean(mention) && matches.length === 0

  useEffect(() => {
    if (!showMentions || !mention || !hostKey || !cwd) {
      setFileMentions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setMentionBusy(true)
      mentionItems(hostKey, cwd, mention.query).then(
        (items) => {
          if (!cancelled) {
            setFileMentions(items)
            setMentionBusy(false)
          }
        },
        () => {
          if (!cancelled) {
            setFileMentions([])
            setMentionBusy(false)
          }
        },
      )
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [showMentions, mention?.query, mention?.start, hostKey, cwd])

  const applyText = (next: string, nextCaret: number) => {
    setText(next)
    onDraftChange?.(next)
    setCaret(nextCaret)
    setSelection({ start: nextCaret, end: nextCaret })
  }

  const pickFileMention = (item: MentionItem) => {
    if (!mention) return
    const next = insertMention(text, caret, mention, item.path, item.dir)
    applyText(next.text, next.caret)
  }

  const pickContextMention = async (kind: ContextMentionKind) => {
    if (!mention || !hostKey || !cwd) return
    setBusy(true)
    setError(undefined)
    try {
      const body = await resolveContextMention(hostKey, cwd, kind.id)
      const inserted = body.endsWith('\n') ? body : `${body}\n`
      const rest = text.slice(caret).replace(/^ /, '')
      const next = text.slice(0, mention.start) + inserted + rest
      applyText(next, mention.start + inserted.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!canSend) return
    sendHaptic()
    setBusy(true)
    setError(undefined)
    try {
      await onSend(text.trim(), ready)
      setText('')
      onDraftChange?.('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.wrap}>
      {matches.length > 0 && (
        <View style={styles.menu} accessibilityRole="menu">
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 260 }}>
            {matches.map((c) => (
              <Pressable
                key={c.name}
                accessibilityRole="menuitem"
                accessibilityLabel={`/${c.name}`}
                onPress={() => setText(insertCommand(c))}
                style={({ pressed }) => [
                  styles.item,
                  pressed && { backgroundColor: colors.active },
                ]}
              >
                <View style={styles.itemHead}>
                  <Text size={13.5} style={{ fontFamily: fonts.mono }}>
                    /{c.name}
                  </Text>
                  {c.hint ? <Faint size={12}>{c.hint}</Faint> : null}
                  {c.kind && c.kind !== 'command' ? <Faint size={11}>{c.kind}</Faint> : null}
                </View>
                {c.description ? (
                  <Muted size={12} numberOfLines={1}>
                    {c.description}
                  </Muted>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            onPress={() => setDismissed(text)}
            style={styles.menuClose}
            accessibilityLabel="Hide commands"
          >
            <Icon icon={X} size={12} />
          </Pressable>
        </View>
      )}
      {showMentions ? (
        <View style={styles.menu} accessibilityRole="menu">
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 260 }}>
            {contextKinds.map((kind) => (
              <Pressable
                key={kind.id}
                accessibilityRole="menuitem"
                accessibilityLabel={kind.label}
                onPress={() => void pickContextMention(kind)}
                style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.active }]}
              >
                <View style={styles.itemHead}>
                  <Text size={13.5} style={{ fontFamily: fonts.mono }}>
                    {kind.label}
                  </Text>
                  <Faint size={12}>{kind.hint}</Faint>
                </View>
              </Pressable>
            ))}
            {fileMentions.map((item) => (
              <Pressable
                key={item.path}
                accessibilityRole="menuitem"
                accessibilityLabel={item.path}
                onPress={() => pickFileMention(item)}
                style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.active }]}
              >
                <View style={styles.itemHead}>
                  <Text size={13.5} numberOfLines={1} style={{ flex: 1 }}>
                    {item.name}
                  </Text>
                  {item.dir ? <Faint size={11}>folder</Faint> : null}
                </View>
                <Muted size={11.5} numberOfLines={1}>
                  {item.path}
                </Muted>
              </Pressable>
            ))}
            {mentionBusy && fileMentions.length === 0 && contextKinds.length === 0 ? (
              <Muted size={12} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                Looking up files…
              </Muted>
            ) : null}
            {!mentionBusy && fileMentions.length === 0 && contextKinds.length === 0 ? (
              <Muted size={12} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                No matching files.
              </Muted>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
      <View style={styles.box}>
        {attachments.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
          >
            {attachments.map((a) =>
              hostKey && a.id && a.status === 'done' && isImageName(a.name) ? (
                <AttachmentImage
                  key={a.key}
                  hostKey={hostKey}
                  name={a.name}
                  id={a.id}
                  onRemove={onRemoveAttachment ? () => onRemoveAttachment(a.key) : undefined}
                />
              ) : (
                <View
                  key={a.key}
                  style={[
                    styles.attachment,
                    a.status === 'error' && { borderColor: colors.danger },
                  ]}
                >
                  {a.status === 'uploading' ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.muted}
                      style={{ transform: [{ scale: 0.7 }] }}
                    />
                  ) : (
                    <Icon
                      icon={Paperclip}
                      size={13}
                      color={a.status === 'error' ? colors.danger : colors.muted}
                    />
                  )}
                  <Text
                    size={12}
                    color={colors.textSecondary}
                    numberOfLines={1}
                    style={{ maxWidth: 160 }}
                  >
                    {a.status === 'error' ? (a.error ?? 'Could not attach') : a.name}
                  </Text>
                  {onRemoveAttachment ? (
                    <Pressable
                      hitSlop={8}
                      onPress={() => onRemoveAttachment(a.key)}
                      accessibilityLabel="Remove attachment"
                    >
                      <Icon icon={X} size={12} />
                    </Pressable>
                  ) : null}
                </View>
              ),
            )}
          </ScrollView>
        )}
        <TextInput
          value={text}
          onChangeText={(value) => {
            setText(value)
            onDraftChange?.(value)
          }}
          onSelectionChange={(e) => {
            const { start, end } = e.nativeEvent.selection
            setCaret(end)
            setSelection(undefined)
          }}
          selection={selection}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          multiline
          autoFocus={autoFocus}
          onKeyPress={(e) => {
            // Backspace in an empty field takes back the newest attachment.
            if (e.nativeEvent.key === 'Backspace' && !text && attachments.length > 0) {
              onRemoveAttachment?.(attachments[attachments.length - 1].key)
            }
          }}
          style={styles.input}
        />
        <View style={styles.row}>
          <View style={styles.left}>
            {onAttach ? (
              <Pressable hitSlop={8} onPress={onAttach} accessibilityLabel="Attach">
                <Icon icon={Plus} size={19} />
              </Pressable>
            ) : null}
            {mode ? (
              <Pressable style={styles.chip} onPress={mode.onPress} disabled={!mode.onPress}>
                <Icon icon={Shield} size={15} />
                <Text size={12.5} color={colors.textSecondary} numberOfLines={1}>
                  {mode.label}
                </Text>
                {mode.onPress ? <Icon icon={CaretDown} size={11} /> : null}
              </Pressable>
            ) : null}
          </View>
          <View style={styles.right}>
            {model ? (
              <Pressable style={styles.chip} onPress={model.onPress} disabled={!model.onPress}>
                <Icon icon={Sparkle} size={14} color={colors.textSecondary} />
                <Text size={12.5} color={colors.textSecondary} numberOfLines={1}>
                  {model.label}
                </Text>
                {model.detail ? <Faint size={12.5}>{model.detail}</Faint> : null}
                {model.onPress ? <Icon icon={CaretDown} size={11} /> : null}
              </Pressable>
            ) : null}
            {running && text.trim().length === 0 ? (
              <Pressable style={styles.send} onPress={onStop} accessibilityLabel="Stop">
                <Icon icon={Stop} size={15} color={colors.text} weight="fill" />
              </Pressable>
            ) : (
              <Pressable
                style={[styles.send, canSend && { backgroundColor: colors.primary }]}
                onPress={() => void send()}
                disabled={!canSend}
                accessibilityLabel="Send"
              >
                <Icon
                  icon={ArrowUp}
                  size={16}
                  color={canSend ? colors.onPrimary : colors.faint}
                  weight="bold"
                />
              </Pressable>
            )}
          </View>
        </View>
      </View>
      {error ? (
        <Text size={12} color={colors.danger} style={{ paddingHorizontal: 4 }}>
          {error}
        </Text>
      ) : context ? (
        <Muted size={11.5} style={{ paddingHorizontal: 4 }}>
          {context}
        </Muted>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  menu: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control + 4,
    backgroundColor: colors.card,
    paddingVertical: 4,
  },
  menuClose: { position: 'absolute', top: 6, right: 8, padding: 4 },
  item: { paddingHorizontal: 12, paddingVertical: 7, gap: 2 },
  itemHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingRight: 24 },
  attachment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.control,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  box: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sheet - 2,
    backgroundColor: colors.panel,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    gap: 8,
  },
  input: {
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14.5,
    maxHeight: 140,
    minHeight: 36,
    paddingTop: 2,
    paddingBottom: 2,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  left: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  send: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.active,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
