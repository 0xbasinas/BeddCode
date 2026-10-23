import { addOutcome, samePath, shortPath, visibleCrumbs } from '@beddcode/client-runtime'
import type { FolderListing, Project } from '@beddcode/contracts'
import { router, useLocalSearchParams } from 'expo-router'
import {
  ArrowUUpLeft,
  CaretDown,
  CaretRight,
  Check,
  Desktop,
  Eye,
  EyeSlash,
  FolderSimple,
  GitBranch,
} from 'phosphor-react-native'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native'

import { hostRequest, refreshProjects, useHostStore, useRuntime } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Header } from '@/ui/Header'
import { Icon } from '@/ui/Icon'
import { MenuSheet } from '@/ui/MenuSheet'
import { Screen } from '@/ui/Screen'
import { Faint, Muted, Text } from '@/ui/Text'

/** Pick a folder on a host to add as a project, browsing that computer's own folders. */
export default function AddFolderScreen() {
  const params = useLocalSearchParams<{ host?: string }>()
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [hostChoice, setHostChoice] = useState<string>()
  const hostKey =
    entries.find((e) => e.key === (hostChoice ?? params.host))?.key ??
    entries.find((e) => runtimes[e.key]?.connection === 'connected')?.key ??
    entries[0]?.key
  const runtime = useRuntime(hostKey)
  const hostName = runtime.host?.name ?? entries.find((e) => e.key === hostKey)?.name ?? 'Host'

  const [listing, setListing] = useState<FolderListing>()
  const [showHidden, setShowHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [hostMenu, setHostMenu] = useState(false)
  const [result, setResult] = useState<{ project: Project; kind: 'added' | 'already' }>()
  const [busy, setBusy] = useState<'add' | 'git'>()

  const browse = useCallback(
    async (path?: string) => {
      if (!hostKey) return
      setLoading(true)
      setError(undefined)
      try {
        setListing(await hostRequest(hostKey, 'folders.browse', { path, showHidden }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [hostKey, showHidden],
  )

  useEffect(() => {
    setResult(undefined)
    if (runtime.connection === 'connected') void browse(listing?.path)
    // Reload when the host or the hidden-folder choice changes, and once it connects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey, showHidden, runtime.connection])

  const add = async () => {
    if (!hostKey || !listing) return
    setBusy('add')
    setError(undefined)
    try {
      const before = runtime.projects
      const project = await hostRequest(hostKey, 'projects.add', { path: listing.path })
      setResult({ project, kind: addOutcome(before, project) })
      await refreshProjects(hostKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  const initGit = async () => {
    if (!hostKey || !result) return
    setBusy('git')
    setError(undefined)
    try {
      const project = await hostRequest(hostKey, 'projects.initGit', { path: result.project.path })
      setResult({ ...result, project })
      await refreshProjects(hostKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  if (entries.length === 0) {
    return (
      <Screen>
        <Header title="Add folder" />
        <View style={styles.center}>
          <Text size={17} weight="semibold">
            No host yet
          </Text>
          <Muted size={13.5} style={{ textAlign: 'center' }}>
            Pair this phone with a computer first, then pick a folder on it.
          </Muted>
          <Button
            label="Add a host"
            kind="primary"
            onPress={() => router.replace('/hosts/add')}
            style={{ alignSelf: 'stretch' }}
          />
        </View>
      </Screen>
    )
  }

  const alreadyAdded = listing
    ? runtime.projects.some((p) => samePath(p.path, listing.path))
    : false

  return (
    <Screen>
      <Header
        title="Add folder"
        subtitle={`on ${hostName}`}
        right={
          <Pressable
            hitSlop={10}
            onPress={() => setShowHidden((v) => !v)}
            accessibilityLabel={showHidden ? 'Hide hidden folders' : 'Show hidden folders'}
          >
            <Icon icon={showHidden ? Eye : EyeSlash} size={20} />
          </Pressable>
        }
      />

      {entries.length > 1 ? (
        <Pressable style={styles.hostPill} onPress={() => setHostMenu(true)}>
          <Icon icon={Desktop} size={15} />
          <Text size={12.5} color={colors.textSecondary}>
            {hostName}
          </Text>
          <Icon icon={CaretDown} size={11} />
        </Pressable>
      ) : null}

      {result ? (
        <View style={styles.center}>
          <View style={styles.badge}>
            <Icon icon={Check} size={24} color={colors.success} />
          </View>
          <Text size={18} weight="semibold" style={{ textAlign: 'center' }}>
            {result.kind === 'already'
              ? 'Already in your projects'
              : `${result.project.name} added`}
          </Text>
          <Text size={12} mono color={colors.muted} style={{ textAlign: 'center' }}>
            {shortPath(result.project.path, listing?.home)}
          </Text>
          {!result.project.isRepo ? (
            <View style={styles.note}>
              <Muted size={12.5}>
                This folder is not a Git repository. Agents can work in it, but worktrees, the Git
                pane and pull requests need one.
              </Muted>
              <Button
                label={busy === 'git' ? 'Running git init…' : 'Initialize Git'}
                disabled={busy !== undefined}
                onPress={() => void initGit()}
              />
            </View>
          ) : null}
          {error ? (
            <Text size={12} color={colors.danger}>
              {error}
            </Text>
          ) : null}
          <View style={{ gap: 8, alignSelf: 'stretch', paddingTop: 6 }}>
            <Button
              label="Start a session here"
              kind="primary"
              onPress={() => router.replace({ pathname: '/new', params: { host: hostKey } })}
            />
            <Button label="Add another folder" onPress={() => setResult(undefined)} />
          </View>
        </View>
      ) : (
        <>
          {listing ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0 }}
              contentContainerStyle={styles.crumbs}
            >
              {visibleCrumbs(listing.crumbs).map((c, i, all) => (
                <View key={c.path} style={styles.crumbRow}>
                  {i > 0 ? <Icon icon={CaretRight} size={10} color={colors.faint} /> : null}
                  <Pressable onPress={() => void browse(c.path)} hitSlop={6}>
                    <Text size={13} color={i === all.length - 1 ? colors.text : colors.muted}>
                      {c.home ? '~' : c.name || c.path}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {runtime.connection !== 'connected' ? (
            <View style={styles.center}>
              <Muted size={13.5}>Connecting to {hostName}…</Muted>
            </View>
          ) : (
            <FlatList
              data={listing?.entries ?? []}
              keyExtractor={(e) => e.path}
              contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}
              ListHeaderComponent={
                listing?.parent ? (
                  <Pressable style={styles.row} onPress={() => void browse(listing.parent!)}>
                    <Icon icon={ArrowUUpLeft} size={18} />
                    <Text size={14} color={colors.muted}>
                      Up one folder
                    </Text>
                  </Pressable>
                ) : undefined
              }
              ListEmptyComponent={
                loading ? (
                  <ActivityIndicator color={colors.muted} style={{ padding: 24 }} />
                ) : (
                  <Muted size={13} style={{ padding: 16 }}>
                    No folders in here.
                  </Muted>
                )
              }
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: colors.hover },
                  ]}
                  onPress={() => void browse(item.path)}
                >
                  <Icon icon={item.isRepo ? GitBranch : FolderSimple} size={18} />
                  <View style={{ flex: 1 }}>
                    <Text size={14} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {item.isRepo && item.branch ? (
                      <Faint size={11.5} mono numberOfLines={1}>
                        {item.branch}
                      </Faint>
                    ) : null}
                  </View>
                  <Icon icon={CaretRight} size={13} color={colors.faint} />
                </Pressable>
              )}
            />
          )}

          <View style={styles.footer}>
            {error ? (
              <Text size={12} color={colors.danger} style={{ paddingBottom: 6 }}>
                {error}
              </Text>
            ) : null}
            <Text
              size={11.5}
              mono
              color={colors.muted}
              numberOfLines={1}
              style={{ paddingBottom: 8 }}
            >
              {listing ? shortPath(listing.path, listing.home) : ' '}
            </Text>
            <Button
              label={
                busy === 'add' ? 'Adding…' : alreadyAdded ? 'Already added' : 'Add this folder'
              }
              kind="primary"
              disabled={!listing || busy !== undefined || alreadyAdded}
              onPress={() => void add()}
            />
          </View>
        </>
      )}

      <MenuSheet
        visible={hostMenu}
        title="Add the folder on"
        onClose={() => setHostMenu(false)}
        items={entries.map((e) => ({
          id: e.key,
          label: runtimes[e.key]?.host?.name ?? e.name,
          hint: runtimes[e.key]?.connection === 'connected' ? 'Online' : 'Offline',
          selected: e.key === hostKey,
          onSelect: () => {
            setListing(undefined)
            setHostChoice(e.key)
          },
        }))}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 28,
  },
  hostPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginHorizontal: 12,
    marginTop: 10,
    backgroundColor: colors.raised,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  crumbs: { gap: 6, paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center' },
  crumbRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderRadius: radius.control,
  },
  footer: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#1c3322',
    alignItems: 'center',
    justifyContent: 'center',
  },
  note: {
    gap: 10,
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    padding: 12,
  },
})
