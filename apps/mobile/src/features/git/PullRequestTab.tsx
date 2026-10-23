import { agoLabel } from '@beddcode/client-runtime'
import { CheckCircle, Clock, Sparkle, XCircle } from 'phosphor-react-native'
import { useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native'

import { hostRequest } from '@/host/store'
import { colors, fonts, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Diffstat } from '@/ui/Diffstat'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'
import { usePolled } from './usePolled'

/** The pull request of this branch: its checks and files, or a form to open one. */
export function PullRequestTab({
  hostKey,
  cwd,
  sessionId,
  instanceId,
  refreshKey,
  active,
}: {
  hostKey: string
  cwd: string
  sessionId: string
  instanceId: string
  refreshKey: number
  active: boolean
}) {
  const pr = usePolled(() => hostRequest(hostKey, 'git.pr.get', { cwd }), refreshKey, active, 8000)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'create'>()
  const [error, setError] = useState<string>()

  if (pr.error && !pr.data) {
    return (
      <View style={styles.center}>
        <Muted size={13.5} style={{ textAlign: 'center' }}>
          {pr.error}
        </Muted>
      </View>
    )
  }
  if (pr.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    )
  }

  if (!pr.data) {
    const generate = async () => {
      setBusy('generate')
      setError(undefined)
      try {
        const r = await hostRequest(hostKey, 'git.generate', { sessionId, instanceId, kind: 'pr' })
        if (r.title) setTitle(r.title)
        if (r.body) setBody(r.body)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(undefined)
      }
    }
    const create = async () => {
      setBusy('create')
      setError(undefined)
      try {
        const r = await hostRequest(hostKey, 'git.pr.create', {
          cwd,
          title: title.trim(),
          body,
          draft,
        })
        pr.refresh()
        void Linking.openURL(r.url)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(undefined)
      }
    }
    return (
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text size={17} weight="semibold">
          Open a pull request
        </Text>
        <Muted size={13}>This branch has no pull request yet. Its commits are pushed first.</Muted>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          placeholderTextColor={colors.faint}
          style={styles.input}
        />
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="Description"
          placeholderTextColor={colors.faint}
          multiline
          style={[styles.input, { minHeight: 120, textAlignVertical: 'top' }]}
        />
        <View style={styles.row}>
          <Muted size={13}>Open as draft</Muted>
          <Switch
            value={draft}
            onValueChange={setDraft}
            trackColor={{ true: colors.accent, false: colors.active }}
          />
        </View>
        {error ? (
          <Text size={12} color={colors.danger}>
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={busy === 'generate' ? 'Writing…' : 'Write with agent'}
            disabled={busy !== undefined}
            onPress={() => void generate()}
            style={{ flex: 1 }}
          />
          <Button
            label={busy === 'create' ? 'Creating…' : 'Create PR'}
            kind="primary"
            disabled={busy !== undefined || !title.trim()}
            onPress={() => void create()}
            style={{ flex: 1 }}
          />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon icon={Sparkle} size={12} />
          <Faint size={11.5}>
            The agent only drafts the text. Nothing is sent until you create it.
          </Faint>
        </View>
      </ScrollView>
    )
  }

  const p = pr.data
  const passed = p.checks.filter((c) => c.state === 'success').length
  const stateColor =
    p.state === 'OPEN' ? colors.success : p.state === 'MERGED' ? '#bb9af7' : colors.danger

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={[
              styles.badge,
              { backgroundColor: p.state === 'OPEN' ? '#1c3322' : colors.raised },
            ]}
          >
            <Text size={11} color={stateColor}>
              {p.isDraft
                ? 'Draft'
                : p.state === 'OPEN'
                  ? 'Open'
                  : p.state === 'MERGED'
                    ? 'Merged'
                    : 'Closed'}
            </Text>
          </View>
          <Muted size={12}>
            #{p.number}
            {p.createdAt ? ` · opened ${agoLabel(p.createdAt)}` : ''}
          </Muted>
        </View>
        <Text size={17} weight="semibold" style={{ lineHeight: 23 }}>
          {p.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text size={11.5} mono style={styles.branch}>
            {p.headBranch}
          </Text>
          <Faint size={12}>→</Faint>
          <Text size={11.5} mono style={styles.branch}>
            {p.baseBranch}
          </Text>
        </View>
        {p.body.trim() ? (
          <Muted size={12.5} style={{ lineHeight: 19 }}>
            {p.body.trim()}
          </Muted>
        ) : null}
        {p.reviewDecision ? (
          <View style={styles.card}>
            <Text size={13} weight="medium">
              Review: {p.reviewDecision.toLowerCase().replace(/_/g, ' ')}
            </Text>
          </View>
        ) : null}
        <View style={{ gap: 9 }}>
          <View style={styles.row}>
            <Faint size={11.5} weight="semibold" style={{ letterSpacing: 0.5 }}>
              CHECKS
            </Faint>
            <Faint size={12}>
              {p.checks.length === 0 ? 'none' : `${passed} of ${p.checks.length} passed`}
            </Faint>
          </View>
          {p.checks.map((c) => (
            <View key={c.name} style={styles.row}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                <Icon
                  icon={
                    c.state === 'success' ? CheckCircle : c.state === 'failure' ? XCircle : Clock
                  }
                  size={15}
                  color={
                    c.state === 'success'
                      ? colors.success
                      : c.state === 'failure'
                        ? colors.danger
                        : colors.accent
                  }
                />
                <Text size={12.5}>{c.name}</Text>
              </View>
              <Faint size={12}>{c.state === 'pending' ? 'running…' : c.state}</Faint>
            </View>
          ))}
        </View>
        <View style={{ gap: 9 }}>
          <Faint size={11.5} weight="semibold" style={{ letterSpacing: 0.5 }}>
            FILES CHANGED · {p.files.length}
          </Faint>
          {p.files.map((f) => (
            <View key={f.path} style={styles.row}>
              <Text size={12.5} color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
                {f.path}
              </Text>
              <Diffstat added={f.added} removed={f.removed} size={12} />
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={styles.footer}>
        <Button label="Open in GitHub" kind="primary" onPress={() => void Linking.openURL(p.url)} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  badge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  branch: {
    backgroundColor: colors.hover,
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    padding: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  footer: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
})
