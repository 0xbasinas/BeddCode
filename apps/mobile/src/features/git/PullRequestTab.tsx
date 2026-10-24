import {
  PR_FILTERS,
  PR_STATE_LABEL,
  agoLabel,
  checksLabel,
  checksSummary,
  githubProblem,
  prStateKind,
  reviewLabel,
  reviewStateLabel,
} from '@beddcode/client-runtime'
import type { PrFilter } from '@beddcode/contracts'
import { ArrowLeft, CheckCircle, Clock, Sparkle, XCircle } from 'phosphor-react-native'
import { useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Pressable,
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

/**
 * Pull requests: this branch's own (or a form to open one), and the repo's list through the
 * host's `gh`, where one opens for its checks and conversation.
 */
export function PullRequestTab(props: {
  hostKey: string
  cwd: string
  sessionId: string
  instanceId: string
  refreshKey: number
  active: boolean
}) {
  const [scope, setScope] = useState<'branch' | 'all'>('branch')
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.scopes}>
        {(
          [
            ['branch', 'This branch'],
            ['all', 'All pull requests'],
          ] as const
        ).map(([id, label]) => (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityState={{ selected: scope === id }}
            onPress={() => setScope(id)}
            style={[styles.chip, scope === id && styles.chipOn]}
          >
            <Text size={12.5} color={scope === id ? colors.text : colors.muted}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {scope === 'branch' ? <BranchPullRequest {...props} /> : <RepoPullRequests {...props} />}
    </View>
  )
}

function BranchPullRequest({
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

const PR_COLOR = {
  open: colors.success,
  draft: colors.muted,
  merged: '#bb9af7',
  closed: colors.danger,
}

function RepoPullRequests({
  hostKey,
  cwd,
  refreshKey,
  active,
}: {
  hostKey: string
  cwd: string
  refreshKey: number
  active: boolean
}) {
  const [filter, setFilter] = useState<PrFilter>('open')
  const [open, setOpen] = useState<number>()
  const status = usePolled(() => hostRequest(hostKey, 'git.gh.status', { cwd }), refreshKey, false)
  const ready = status.data?.state === 'ready'
  const list = usePolled(
    async () =>
      ready
        ? { filter, ...(await hostRequest(hostKey, 'git.pr.list', { cwd, filter })) }
        : undefined,
    `${refreshKey}:${filter}:${ready}`,
    active && ready && open === undefined,
    30_000,
  )
  if (status.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    )
  }
  const problem = status.error
    ? { title: 'GitHub is unavailable', detail: status.error }
    : githubProblem(status.data)
  if (problem) {
    return (
      <View style={[styles.center, { gap: 10 }]}>
        <Text size={15} weight="semibold">
          {problem.title}
        </Text>
        <Muted size={13} style={{ textAlign: 'center' }}>
          {problem.detail}
        </Muted>
        {'command' in problem && problem.command ? (
          <Text size={12.5} mono selectable style={styles.branch}>
            {problem.command}
          </Text>
        ) : null}
        <Button label="Check again" onPress={status.refresh} />
      </View>
    )
  }
  if (open !== undefined) {
    return (
      <PullRequestDetailView
        hostKey={hostKey}
        cwd={cwd}
        number={open}
        active={active}
        onBack={() => setOpen(undefined)}
      />
    )
  }
  const items = list.data?.filter === filter ? list.data.items : undefined
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 6 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6 }}
      >
        {PR_FILTERS.map((f) => (
          <Pressable
            key={f.id}
            onPress={() => setFilter(f.id)}
            style={[styles.chip, filter === f.id && styles.chipOn]}
          >
            <Text size={12} color={filter === f.id ? colors.text : colors.muted}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {list.error ? (
        <Text size={12} color={colors.danger}>
          {list.error}
        </Text>
      ) : null}
      {!items && !list.error ? (
        <ActivityIndicator color={colors.muted} style={{ margin: 16 }} />
      ) : null}
      {items?.length === 0 ? <Muted size={13}>No pull requests here.</Muted> : null}
      {items?.map((pr) => {
        const kind = prStateKind(pr)
        return (
          <Pressable key={pr.number} onPress={() => setOpen(pr.number)} style={styles.prRow}>
            <View style={[styles.dot, { backgroundColor: PR_COLOR[kind] }]} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text size={13.5} numberOfLines={2}>
                {pr.title}
              </Text>
              <Faint size={11.5} numberOfLines={1}>
                #{pr.number} · {pr.author}
                {pr.updatedAt ? ` · ${agoLabel(pr.updatedAt)}` : ''} · {pr.headBranch} →{' '}
                {pr.baseBranch}
              </Faint>
              <Faint size={11.5}>
                {PR_STATE_LABEL[kind]}
                {pr.checks ? ` · ${checksLabel(pr)}` : ''}
                {reviewLabel(pr.reviewDecision) ? ` · ${reviewLabel(pr.reviewDecision)}` : ''}
              </Faint>
            </View>
          </Pressable>
        )
      })}
      {status.data?.state === 'ready' ? (
        <Faint size={11.5} style={{ marginTop: 8 }}>
          Signed in as {status.data.login} · {status.data.repo}
        </Faint>
      ) : null}
    </ScrollView>
  )
}

function PullRequestDetailView({
  hostKey,
  cwd,
  number,
  active,
  onBack,
}: {
  hostKey: string
  cwd: string
  number: number
  active: boolean
  onBack(): void
}) {
  const [bump, setBump] = useState(0)
  const pr = usePolled(
    () => hostRequest(hostKey, 'git.pr.view', { cwd, number }),
    `${number}:${bump}`,
    active,
    20_000,
  )
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const send = async (action: { action: 'comment'; body: string } | { action: 'ready' }) => {
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'git.pr.act', { cwd, number, do: action })
      if (action.action === 'comment') setComment('')
      setBump((b) => b + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const d = pr.data
  return (
    <View style={{ flex: 1 }}>
      <Pressable
        onPress={onBack}
        style={[styles.row, { padding: 12, justifyContent: 'flex-start' }]}
      >
        <Icon icon={ArrowLeft} size={15} />
        <Muted size={13}>All pull requests</Muted>
      </Pressable>
      {!d ? (
        <View style={styles.center}>
          {pr.error ? (
            <Muted size={13}>{pr.error}</Muted>
          ) : (
            <ActivityIndicator color={colors.muted} />
          )}
        </View>
      ) : (
        <>
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingTop: 0, gap: 12 }}
            keyboardShouldPersistTaps="handled"
          >
            <Muted size={12}>
              {PR_STATE_LABEL[prStateKind(d)]} · #{d.number} · {d.author}
              {d.updatedAt ? ` · updated ${agoLabel(d.updatedAt)}` : ''}
            </Muted>
            <Text size={17} weight="semibold" style={{ lineHeight: 23 }}>
              {d.title}
            </Text>
            <Faint size={12} mono>
              {d.headBranch} → {d.baseBranch}
            </Faint>
            {d.body.trim() ? (
              <Muted size={12.5} style={{ lineHeight: 19 }}>
                {d.body.trim()}
              </Muted>
            ) : null}
            {d.checks.length > 0 ? (
              <Faint size={12}>{checksLabel(checksSummary(d.checks))}</Faint>
            ) : null}
            {d.timeline.map((t, i) => (
              <View key={i} style={styles.card}>
                <Text size={12.5} weight="medium">
                  {t.author}{' '}
                  <Faint size={12}>
                    {t.kind === 'review' ? reviewStateLabel(t.state) : 'commented'}
                    {t.at ? ` · ${agoLabel(t.at)}` : ''}
                  </Faint>
                </Text>
                {t.body.trim() ? (
                  <Muted size={12.5} style={{ marginTop: 4 }}>
                    {t.body.trim()}
                  </Muted>
                ) : null}
              </View>
            ))}
            <TextInput
              value={comment}
              onChangeText={setComment}
              placeholder="Add a comment"
              placeholderTextColor={colors.faint}
              multiline
              style={[styles.input, { minHeight: 60, textAlignVertical: 'top' }]}
            />
            {error ? (
              <Text size={12} color={colors.danger}>
                {error}
              </Text>
            ) : null}
          </ScrollView>
          <View style={[styles.footer, { flexDirection: 'row', gap: 8 }]}>
            {comment.trim() ? (
              <Button
                label={busy ? 'Sending…' : 'Comment'}
                disabled={busy}
                onPress={() => void send({ action: 'comment', body: comment })}
                style={{ flex: 1 }}
              />
            ) : d.isDraft && d.state === 'OPEN' ? (
              <Button
                label="Ready for review"
                disabled={busy}
                onPress={() => void send({ action: 'ready' })}
                style={{ flex: 1 }}
              />
            ) : null}
            <Button
              label="Open in GitHub"
              kind="primary"
              onPress={() => void Linking.openURL(d.url)}
              style={{ flex: 1 }}
            />
          </View>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  scopes: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  chip: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  chipOn: { backgroundColor: colors.hover },
  prRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    padding: 10,
    borderRadius: radius.panel,
    backgroundColor: colors.card,
  },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 6 },
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
