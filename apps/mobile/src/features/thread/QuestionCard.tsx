import type { TranscriptItem } from '@beddcode/client-runtime'
import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { colors, fonts, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Faint, Muted, Text } from '@/ui/Text'

type QuestionItem = Extract<TranscriptItem, { kind: 'question' }>

/** Questions the agent asks you mid-turn: pick an answer or type one, then send them all. */
export function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem
  onAnswer(requestId: string, answers?: Record<string, string[]>): Promise<void>
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const closed = Boolean(item.answers) || Boolean(item.dismissed)

  if (closed) {
    return (
      <View style={styles.card}>
        {item.questions.map((q) => (
          <View key={q.id} style={{ gap: 2 }}>
            <Faint size={12.5}>{q.question}</Faint>
            <Text size={13} color={colors.textSecondary}>
              {item.dismissed ? 'Dismissed' : (item.answers?.[q.id] ?? []).join(', ') || '—'}
            </Text>
          </View>
        ))}
      </View>
    )
  }

  const answers = (): Record<string, string[]> =>
    Object.fromEntries(
      item.questions.map((q) => {
        const other = typed[q.id]?.trim()
        return [q.id, [...(picked[q.id] ?? []), ...(other ? [other] : [])]]
      }),
    )
  const complete = item.questions.every((q) => answers()[q.id]!.length > 0)

  const submit = async (value?: Record<string, string[]>) => {
    setBusy(true)
    setError(undefined)
    try {
      await onAnswer(item.requestId, value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const toggle = (id: string, label: string, multi: boolean) =>
    setPicked((p) => {
      const current = p[id] ?? []
      if (!multi) return { ...p, [id]: [label] }
      return {
        ...p,
        [id]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
      }
    })

  return (
    <View style={styles.card}>
      {item.questions.map((q) => {
        const hasOptions = (q.options?.length ?? 0) > 0
        const showInput = hasOptions ? Boolean(q.allowOther) : true
        return (
          <View key={q.id} style={{ gap: 8 }}>
            {q.header ? <Faint size={11.5}>{q.header}</Faint> : null}
            <Text size={14}>{q.question}</Text>
            {q.options?.map((o) => {
              const on = picked[q.id]?.includes(o.label)
              return (
                <Pressable
                  key={o.label}
                  onPress={() => toggle(q.id, o.label, Boolean(q.multiSelect))}
                  style={[
                    styles.option,
                    on && { borderColor: colors.accent, backgroundColor: colors.accentSoft },
                  ]}
                >
                  <Text size={13.5}>{o.label}</Text>
                  {o.description ? <Muted size={12}>{o.description}</Muted> : null}
                </Pressable>
              )
            })}
            {showInput ? (
              <TextInput
                value={typed[q.id] ?? ''}
                onChangeText={(v) => setTyped((t) => ({ ...t, [q.id]: v }))}
                secureTextEntry={q.secret}
                placeholder="Type an answer"
                placeholderTextColor={colors.faint}
                style={styles.input}
              />
            ) : null}
          </View>
        )
      })}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label="Send"
          kind="primary"
          onPress={() => void submit(answers())}
          disabled={!complete || busy}
          style={{ flex: 1 }}
        />
        <Button label="Dismiss" onPress={() => void submit(undefined)} disabled={busy} />
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
    gap: 12,
  },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
})
