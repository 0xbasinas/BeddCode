import type { TranscriptItem } from '@beddcode/client-runtime'
import { Check, CirclesThree, Shield, X } from 'phosphor-react-native'
import { useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Markdown from '@ronradtke/react-native-markdown-display'

import { colors, fonts, radius } from '@/theme/tokens'
import { Icon } from '@/ui/Icon'
import { Faint, Text } from '@/ui/Text'

type ApprovalItem = Extract<TranscriptItem, { kind: 'approval' }>

/** "Run this command?" reads better than the provider's "Running Bash: …" for a question. */
const questionTitle = (title: string) =>
  title.startsWith('Running ') ? 'Run this command?' : title

const firstLine = (text: string | undefined) =>
  text
    ?.split('\n')
    .find((l) => l.trim())
    ?.trim()

/**
 * A permission request: what is asked, the command it concerns, and the choices. The buttons are
 * the agent's own options, so "Always for this session" and the like are whatever it offers.
 * Once answered it shrinks to one line.
 */
export function ApprovalCard({
  item,
  cwd,
  onApprove,
}: {
  item: ApprovalItem
  cwd?: string
  onApprove(requestId: string, optionId: string): Promise<void>
}) {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const submitting = useRef(false)
  const answered = item.options.find((o) => o.id === item.resolvedOptionId)
  const resolved = Boolean(item.resolvedOptionId) || Boolean(item.cancelled)
  const preview = firstLine(item.detail)
  const title = questionTitle(item.title)

  const answer = async (optionId: string) => {
    if (submitting.current || resolved) return
    submitting.current = true
    setBusy(optionId)
    setError(undefined)
    try {
      await onApprove(item.requestId, optionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      submitting.current = false
      setBusy(undefined)
    }
  }

  if (resolved) {
    const state = item.cancelled
      ? 'cancelled'
      : answered?.kind === 'deny'
        ? 'denied'
        : answered?.kind === 'allow'
          ? 'allowed'
          : 'answered'
    const verdict =
      state === 'allowed'
        ? answered?.label === 'Always for this session'
          ? 'Allowed for this session'
          : 'Allowed'
        : state === 'denied'
          ? 'Denied'
          : state === 'cancelled'
            ? 'Cancelled'
            : (answered?.label ?? 'Answered')
    return (
      <View style={styles.done}>
        <Icon
          icon={state === 'allowed' ? Check : state === 'denied' ? X : CirclesThree}
          size={13}
          color={colors.faint}
        />
        <Faint size={12.5}>{verdict}</Faint>
        <Text size={12} mono color={colors.muted} numberOfLines={1} style={{ flex: 1 }}>
          {preview ?? title.replace(/\?$/, '')}
        </Text>
      </View>
    )
  }

  const allow = item.options.filter((o) => o.kind === 'allow')
  const rest = item.options.filter((o) => o.kind !== 'allow')

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Icon icon={Shield} size={15} color={colors.accent} />
        <Text size={13.5} color={colors.muted} style={{ flex: 1 }}>
          {title}
        </Text>
      </View>
      {item.plan ? (
        <Markdown
          style={{
            body: {
              color: colors.textSecondary,
              fontFamily: fonts.regular,
              fontSize: 13.5,
              lineHeight: 20,
            },
          }}
        >
          {item.plan}
        </Markdown>
      ) : preview ? (
        <Text size={13} mono selectable>
          {preview}
        </Text>
      ) : null}
      {cwd && !item.plan ? (
        <Text size={11.5} mono color={colors.faint} numberOfLines={1}>
          {cwd}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {allow.map((o) => (
          <Pressable
            key={o.id}
            disabled={busy !== undefined}
            onPress={() => void answer(o.id)}
            style={[styles.action, styles.allow]}
          >
            <Text size={14} weight="medium" color={colors.accent}>
              {busy === o.id ? '…' : o.label}
            </Text>
          </Pressable>
        ))}
        {rest.map((o) => (
          <Pressable
            key={o.id}
            disabled={busy !== undefined}
            onPress={() => void answer(o.id)}
            style={styles.action}
          >
            <Text size={14} color={o.kind === 'deny' ? colors.text : colors.muted}>
              {busy === o.id ? '…' : o.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? (
        <Text size={12} color={colors.danger}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    padding: 14,
    gap: 8,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  action: {
    minHeight: 40,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: radius.control,
    backgroundColor: colors.raised,
  },
  allow: { backgroundColor: colors.accentSoft },
  done: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
})
