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
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { EMPTY_ATTACHMENTS, type DraftAttachment } from '@/host/attachments'
import { colors, fonts, radius } from '@/theme/tokens'
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
}) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const uploading = attachments.some((a) => a.status === 'uploading')
  const ready = attachments.filter((a) => a.status === 'done' && a.id).map((a) => a.id!)
  const canSend = text.trim().length > 0 && !busy && !uploading

  const send = async () => {
    if (!canSend) return
    setBusy(true)
    setError(undefined)
    try {
      await onSend(text.trim(), ready)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.box}>
        {attachments.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
          >
            {attachments.map((a) => (
              <View
                key={a.key}
                style={[styles.attachment, a.status === 'error' && { borderColor: colors.danger }]}
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
            ))}
          </ScrollView>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          multiline
          autoFocus={autoFocus}
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
