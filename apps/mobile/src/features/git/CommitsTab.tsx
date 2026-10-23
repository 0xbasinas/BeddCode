import { agoLabel } from '@beddcode/client-runtime'
import type { GitCommit } from '@beddcode/contracts'
import { GitBranch, Sparkle } from 'phosphor-react-native'
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native'

import { hostRequest } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Diffstat } from '@/ui/Diffstat'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'
import { usePolled } from './usePolled'

function CommitRow({
  commit,
  agent,
  open,
  onPress,
}: {
  commit: GitCommit
  agent: boolean
  open: boolean
  onPress(): void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.commit, open && { backgroundColor: colors.raised }]}
    >
      <View style={styles.avatar}>
        {agent ? (
          <Icon icon={Sparkle} size={12} color={colors.text} />
        ) : (
          <Text size={11}>{commit.author.slice(0, 1).toUpperCase()}</Text>
        )}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={13.5}>{commit.subject}</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <Faint size={11.5} mono numberOfLines={1} style={{ flexShrink: 1 }}>
            {commit.hash.slice(0, 7)} · {commit.author} · {agoLabel(commit.at)}
          </Faint>
          <Diffstat added={commit.added} removed={commit.removed} size={11.5} />
        </View>
        {open
          ? commit.files.map((f) => (
              <View
                key={f.path}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingTop: 4,
                  gap: 8,
                }}
              >
                <Text size={12} color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
                  {f.path}
                </Text>
                <Diffstat added={f.added} removed={f.removed} size={12} />
              </View>
            ))
          : null}
      </View>
    </Pressable>
  )
}

/** Commits on this branch: the ones not pushed yet, then what is already on the remote. */
export function CommitsTab({
  hostKey,
  cwd,
  refreshKey,
  active,
  onOpenPr,
}: {
  hostKey: string
  cwd: string
  refreshKey: number
  active: boolean
  onOpenPr(): void
}) {
  const log = usePolled(() => hostRequest(hostKey, 'git.log', { cwd }), refreshKey, active)
  const info = usePolled(() => hostRequest(hostKey, 'git.info', { cwd }), refreshKey, active, 8000)
  const [openHash, setOpenHash] = useState<string>()
  const [pushing, setPushing] = useState(false)
  const [error, setError] = useState<string>()

  if (log.error && !log.data) {
    return (
      <View style={styles.center}>
        <Muted size={13.5} style={{ textAlign: 'center' }}>
          {/not a git repository/i.test(log.error)
            ? 'This folder is not a Git repository.'
            : log.error}
        </Muted>
      </View>
    )
  }
  if (log.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    )
  }

  const unpushed = log.data?.unpushed ?? []
  const pushed = log.data?.pushed ?? []

  const push = async () => {
    setPushing(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'git.push', { cwd })
      log.refresh()
    } catch (err) {
      setError(`Push failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPushing(false)
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.branch}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Icon icon={GitBranch} size={15} />
          <Text size={12.5} mono numberOfLines={1}>
            {info.data?.branch ?? 'detached'}
          </Text>
        </View>
        {log.data?.base ? <Faint size={12}>vs {log.data.base}</Faint> : null}
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}>
        {unpushed.length > 0 && (
          <>
            <Faint size={11.5} weight="semibold" style={styles.section}>
              NOT PUSHED · {unpushed.length}
            </Faint>
            {unpushed.map((c) => (
              <CommitRow
                key={c.hash}
                commit={c}
                agent
                open={openHash === c.hash}
                onPress={() => setOpenHash(openHash === c.hash ? undefined : c.hash)}
              />
            ))}
          </>
        )}
        {pushed.length > 0 && (
          <>
            <Faint size={11.5} weight="semibold" style={styles.section}>
              ON ORIGIN
            </Faint>
            {pushed.map((c) => (
              <CommitRow
                key={c.hash}
                commit={c}
                agent={false}
                open={openHash === c.hash}
                onPress={() => setOpenHash(openHash === c.hash ? undefined : c.hash)}
              />
            ))}
          </>
        )}
        {unpushed.length === 0 && pushed.length === 0 ? (
          <Muted size={13.5} style={{ padding: 16 }}>
            No commits on this branch yet.
          </Muted>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        {error ? (
          <Text size={12} color={colors.danger} style={{ paddingBottom: 6 }}>
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={
              pushing
                ? 'Pushing…'
                : unpushed.length > 0
                  ? `Push ${unpushed.length} commit${unpushed.length === 1 ? '' : 's'}`
                  : 'Push'
            }
            kind="primary"
            disabled={pushing || unpushed.length === 0}
            onPress={() => void push()}
            style={{ flex: 1 }}
          />
          <Button label="Open PR" onPress={onOpenPr} style={{ flex: 1 }} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  branch: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  section: { paddingHorizontal: 8, paddingTop: 14, paddingBottom: 6, letterSpacing: 0.5 },
  commit: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radius.panel,
  },
  avatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#2c2c2c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
})
