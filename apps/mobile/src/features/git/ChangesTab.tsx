import {
  commitLabel,
  diffRefreshKey,
  groupByDirectory,
  selectedPaths,
} from '@beddcode/client-runtime'
import type { GitFile } from '@beddcode/contracts'
import {
  Check,
  CaretDown,
  CaretRight,
  FolderSimple,
  GitBranch,
  Sparkle,
} from 'phosphor-react-native'
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { hostRequest } from '@/host/store'
import { colors, fonts, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Diffstat } from '@/ui/Diffstat'
import { Icon } from '@/ui/Icon'
import { PatchView } from '@/ui/PatchView'
import { Faint, Muted, Text } from '@/ui/Text'
import { usePolled } from './usePolled'

const STATUS_COLOR: Record<GitFile['status'], string> = {
  M: colors.accent,
  A: colors.success,
  D: colors.danger,
  R: colors.info,
}

function Checkbox({ on, onPress }: { on: boolean; onPress(): void }) {
  return (
    <Pressable
      hitSlop={8}
      onPress={onPress}
      style={[styles.box, on && { backgroundColor: colors.primary, borderColor: colors.primary }]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
    >
      {on ? <Icon icon={Check} size={12} color={colors.onPrimary} weight="bold" /> : null}
    </Pressable>
  )
}

function FileDiff({
  hostKey,
  cwd,
  file,
  paneKey,
  active,
}: {
  hostKey: string
  cwd: string
  file: GitFile
  paneKey: number
  active: boolean
}) {
  const diff = usePolled(
    () => hostRequest(hostKey, 'git.diff', { cwd, path: file.path }),
    diffRefreshKey(file, paneKey),
    active,
    0,
  )
  if (diff.loading) return <ActivityIndicator color={colors.muted} style={{ padding: 10 }} />
  if (diff.error)
    return (
      <Text size={12} color={colors.danger} style={{ padding: 10 }}>
        {diff.error}
      </Text>
    )
  if (!diff.data || diff.data.truncated || !diff.data.patch.trim())
    return (
      <Faint size={12} style={{ padding: 10 }}>
        {diff.data?.truncated ? 'Too large to show here.' : 'No textual changes.'}
      </Faint>
    )
  return <PatchView patch={diff.data.patch} max={160} />
}

/** What changed in the working tree, what to include, and committing it. */
export function ChangesTab({
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
  const status = usePolled(() => hostRequest(hostKey, 'git.status', { cwd }), refreshKey, active)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [openDiff, setOpenDiff] = useState<string>()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'generate' | 'commit' | 'commit-push'>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const files = status.data?.files ?? []
  const groups = groupByDirectory(files)
  const selected = selectedPaths(files, overrides)
  const total = files.reduce((n, f) => ({ a: n.a + f.added, r: n.r + f.removed }), { a: 0, r: 0 })

  if (status.error && !status.data) {
    return (
      <View style={styles.center}>
        <Muted size={13.5} style={{ textAlign: 'center' }}>
          {/not a git repository/i.test(status.error)
            ? 'This folder is not a Git repository.'
            : status.error}
        </Muted>
      </View>
    )
  }
  if (status.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    )
  }

  const toggleFile = (f: GitFile) =>
    setOverrides((o) => ({ ...o, [f.path]: !selected.includes(f.path) }))
  const allOn = selected.length === files.length && files.length > 0
  const toggleAll = () => setOverrides(Object.fromEntries(files.map((f) => [f.path, !allOn])))

  const generate = async () => {
    setBusy('generate')
    setError(undefined)
    try {
      const r = await hostRequest(hostKey, 'git.generate', {
        sessionId,
        instanceId,
        kind: 'commit',
        paths: selected,
      })
      if (r.message) setMessage(r.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  const commit = async (push: boolean) => {
    setBusy(push ? 'commit-push' : 'commit')
    setError(undefined)
    setNotice(undefined)
    try {
      const r = await hostRequest(hostKey, 'git.commit', {
        cwd,
        message: message.trim(),
        paths: selected,
        push,
      })
      setMessage('')
      setOverrides({})
      setNotice(
        r.pushError
          ? `Committed ${r.hash.slice(0, 7)}. Push failed: ${r.pushError}`
          : `Committed ${r.hash.slice(0, 7)}${r.pushed ? ' and pushed' : ''}`,
      )
      status.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.branch}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 }}>
          <Icon icon={GitBranch} size={15} />
          <Text size={12.5} mono numberOfLines={1} style={{ flexShrink: 1 }}>
            {status.data?.branch ?? 'detached'}
          </Text>
          {status.data && status.data.ahead > 0 ? (
            <Text size={12} color={colors.success}>
              ↑{status.data.ahead}
            </Text>
          ) : null}
          {status.data && status.data.behind > 0 ? (
            <Text size={12} color={colors.accent}>
              ↓{status.data.behind}
            </Text>
          ) : null}
        </View>
        <Diffstat added={total.a} removed={total.r} size={12.5} />
      </View>
      {files.length === 0 ? (
        <View style={styles.center}>
          <Muted size={13.5}>Nothing to commit. The working tree is clean.</Muted>
        </View>
      ) : (
        <>
          <View style={styles.selectRow}>
            <Pressable
              style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}
              onPress={toggleAll}
            >
              <Checkbox on={allOn} onPress={toggleAll} />
              <Muted size={12.5}>
                {selected.length} of {files.length} selected
              </Muted>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}>
            {groups.map((g) => {
              const isCollapsed = collapsed.has(g.dir)
              return (
                <View key={g.dir}>
                  <Pressable
                    style={styles.dir}
                    onPress={() =>
                      setCollapsed((c) => {
                        const n = new Set(c)
                        if (!n.delete(g.dir)) n.add(g.dir)
                        return n
                      })
                    }
                  >
                    <Icon
                      icon={isCollapsed ? CaretRight : CaretDown}
                      size={11}
                      color={colors.faint}
                    />
                    <Icon icon={FolderSimple} size={15} />
                    <Text size={12.5} mono>
                      {g.dir || '.'}
                    </Text>
                  </Pressable>
                  {!isCollapsed &&
                    g.files.map((f) => (
                      <View key={f.path}>
                        <Pressable
                          style={[
                            styles.file,
                            openDiff === f.path && { backgroundColor: colors.raised },
                          ]}
                          onPress={() => setOpenDiff(openDiff === f.path ? undefined : f.path)}
                        >
                          <Checkbox on={selected.includes(f.path)} onPress={() => toggleFile(f)} />
                          <Text
                            size={13.5}
                            color={selected.includes(f.path) ? colors.text : colors.muted}
                            numberOfLines={1}
                            style={{ flex: 1 }}
                          >
                            {f.name}
                          </Text>
                          <Diffstat added={f.added} removed={f.removed} />
                          <Text
                            size={12}
                            weight="semibold"
                            color={STATUS_COLOR[f.status]}
                            style={{ width: 14, textAlign: 'right' }}
                          >
                            {f.status}
                          </Text>
                        </Pressable>
                        {openDiff === f.path ? (
                          <View style={styles.diff}>
                            <FileDiff
                              hostKey={hostKey}
                              cwd={cwd}
                              file={f}
                              paneKey={refreshKey}
                              active={active}
                            />
                          </View>
                        ) : null}
                      </View>
                    ))}
                </View>
              )
            })}
          </ScrollView>
          <View style={styles.commit}>
            <View style={styles.messageBox}>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder="Commit message"
                placeholderTextColor={colors.faint}
                multiline
                style={styles.messageInput}
              />
              <View style={styles.messageFoot}>
                <Pressable
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
                  onPress={() => void generate()}
                  disabled={busy !== undefined || selected.length === 0}
                >
                  {busy === 'generate' ? (
                    <ActivityIndicator size="small" color={colors.muted} />
                  ) : (
                    <Icon icon={Sparkle} size={13} />
                  )}
                  <Faint size={11.5}>Rewrite with agent</Faint>
                </Pressable>
                <Faint size={11.5}>{message.length}</Faint>
              </View>
            </View>
            {error ? (
              <Text size={12} color={colors.danger}>
                {error}
              </Text>
            ) : null}
            {notice ? (
              <Text size={12} color={colors.success}>
                {notice}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                label={busy === 'commit' ? 'Committing…' : commitLabel(selected.length)}
                kind="primary"
                disabled={busy !== undefined || selected.length === 0 || !message.trim()}
                onPress={() => void commit(false)}
                style={{ flex: 1 }}
              />
              <Button
                label={busy === 'commit-push' ? 'Pushing…' : 'Commit & push'}
                disabled={busy !== undefined || selected.length === 0 || !message.trim()}
                onPress={() => void commit(true)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </>
      )}
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
    gap: 8,
  },
  selectRow: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  dir: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 9,
  },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: radius.control,
  },
  diff: {
    marginHorizontal: 6,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.control,
    overflow: 'hidden',
  },
  box: {
    width: 17,
    height: 17,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#4a4a4a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commit: {
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  messageBox: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 6,
  },
  messageInput: {
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 13.5,
    minHeight: 38,
    maxHeight: 110,
  },
  messageFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
})
