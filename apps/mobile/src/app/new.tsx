import { effortLabel, folderName } from '@beddcode/client-runtime'
import { router, useLocalSearchParams } from 'expo-router'
import {
  CaretDown,
  Desktop,
  FolderSimple,
  FolderSimplePlus,
  GitBranch,
  Robot,
} from 'phosphor-react-native'
import { useEffect, useMemo, useState } from 'react'
import type { SlashCommand } from '@beddcode/contracts'
import { Pressable, StyleSheet, View } from 'react-native'

import { Composer } from '@/features/composer/Composer'
import { ModelPicker } from '@/features/composer/ModelPicker'
import {
  createSession,
  hostRequest,
  prompt,
  readyProviders,
  useHostStore,
  useRuntime,
} from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Header } from '@/ui/Header'
import { Icon } from '@/ui/Icon'
import { MenuSheet, type MenuItem } from '@/ui/MenuSheet'
import { Screen } from '@/ui/Screen'
import { Muted, Text } from '@/ui/Text'

type Which = 'host' | 'agent' | 'folder' | 'workspace' | 'mode' | 'model' | null

/** A new session: say what it is for, pick the agent and folder, and nothing runs until you send. */
export default function NewSessionScreen() {
  const params = useLocalSearchParams<{ host?: string; folder?: string }>()
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [hostKey, setHostKey] = useState<string>()
  const host =
    entries.find((e) => e.key === (hostKey ?? params.host))?.key ??
    entries.find((e) => runtimes[e.key]?.connection === 'connected')?.key ??
    entries[0]?.key
  const runtime = useRuntime(host)
  const providers = readyProviders(runtime.providers)

  const [agentId, setAgentId] = useState<string>()
  const agent = providers.find((p) => p.id === agentId) ?? providers[0]
  const [folder, setFolder] = useState<string | null | undefined>(undefined)
  const projects = runtime.projects
  // The folder whose + was tapped comes first; 'none' means a session without a project.
  const startFolder = params.folder === 'none' ? null : (params.folder ?? projects[0]?.path ?? null)
  const chosenFolder = folder === undefined ? startFolder : folder
  const project = projects.find((p) => p.path === chosenFolder)
  const [worktree, setWorktree] = useState(true)
  const useWorktree = Boolean(chosenFolder && project?.isRepo && worktree)

  const modes = agent?.capabilities.permissionModes ?? []
  const [modeId, setModeId] = useState<string>()
  const mode = modes.find((m) => m.id === modeId) ?? modes.find((m) => !m.dangerous) ?? modes[0]

  const models = agent?.capabilities.models ?? []
  const [modelId, setModelId] = useState<string>()
  const [effort, setEffort] = useState<string>()
  const model = models.find((m) => m.id === modelId)

  const [which, setWhich] = useState<Which>(null)
  const close = () => setWhich(null)

  const hostLabel = (key: string) =>
    runtimes[key]?.host?.name ?? entries.find((e) => e.key === key)?.name ?? 'Host'

  const menu = useMemo<{ title: string; items: MenuItem[] }>(() => {
    switch (which) {
      case 'host':
        return {
          title: 'Run on',
          items: entries.map((e) => ({
            id: e.key,
            label: hostLabel(e.key),
            hint: runtimes[e.key]?.connection === 'connected' ? 'Online' : 'Offline',
            selected: e.key === host,
            onSelect: () => {
              setHostKey(e.key)
              setAgentId(undefined)
              setFolder(undefined)
            },
          })),
        }
      case 'agent':
        return {
          title: 'Agent',
          items: providers.map((p) => ({
            id: p.id,
            label: p.label,
            hint: p.version,
            selected: p.id === agent?.id,
            onSelect: () => {
              setAgentId(p.id)
              setModeId(undefined)
              setModelId(undefined)
              setEffort(undefined)
            },
          })),
        }
      case 'folder':
        return {
          title: 'Folder',
          items: [
            ...projects.map((p) => ({
              id: p.path,
              label: p.name || folderName(p.path),
              hint: p.path,
              selected: p.path === chosenFolder,
              onSelect: () => setFolder(p.path),
            })),
            {
              id: 'add-folder',
              label: 'Add a folder…',
              hint: 'Browse the host\x27s folders',
              icon: FolderSimplePlus,
              onSelect: () => router.push({ pathname: '/folders/add', params: { host } }),
            },
            {
              id: 'none',
              label: 'No project',
              hint: 'The host keeps a folder for it',
              selected: chosenFolder === null,
              onSelect: () => setFolder(null),
            },
          ],
        }
      case 'workspace':
        return {
          title: 'Where the agent works',
          items: [
            {
              id: 'worktree',
              label: 'New worktree from main',
              hint: 'Its own branch, apart from your checkout',
              selected: worktree,
              onSelect: () => setWorktree(true),
            },
            {
              id: 'local',
              label: 'Work in the folder itself',
              selected: !worktree,
              onSelect: () => setWorktree(false),
            },
          ],
        }
      case 'mode':
        return {
          title: 'How much it asks',
          items: modes.map((m) => ({
            id: m.id,
            label: m.label,
            hint: m.description,
            danger: m.dangerous,
            selected: m.id === mode?.id,
            onSelect: () => setModeId(m.id),
          })),
        }
      default:
        return { title: '', items: [] }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    which,
    entries,
    runtimes,
    providers,
    projects,
    models,
    modes,
    worktree,
    host,
    agent,
    chosenFolder,
    mode,
    model,
    modelId,
  ])

  // The agent's slash commands for this folder, so `/` works before the session exists.
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const connected = runtime.connection === 'connected'
  useEffect(() => {
    setCommands([])
    if (!host || !agent?.capabilities.commands || !connected) return
    let cancelled = false
    hostRequest(host, 'commands.list', {
      instanceId: agent.id,
      cwd: chosenFolder || undefined,
    }).then(
      (list) => !cancelled && setCommands(list),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [host, agent?.id, agent?.capabilities.commands, chosenFolder, connected])

  const send = async (value: string, _attachments: string[]) => {
    if (!host) throw new Error('Add a host first')
    if (!agent) throw new Error('No agent is ready on this host')
    const sessionId = await createSession(host, {
      instanceId: agent.id,
      cwd: chosenFolder || undefined,
      projectless: !chosenFolder || undefined,
      permissionMode: mode?.id,
      model: model?.id,
      effort,
      workspace: useWorktree ? { mode: 'worktree' } : undefined,
    })
    await prompt(sessionId, value)
    router.replace({ pathname: '/session/[id]', params: { id: sessionId } })
  }

  const chip = (icon: typeof Robot, label: string, which: Which, disabled?: boolean) => (
    <Pressable
      key={String(which)}
      style={[styles.chip, disabled && { opacity: 0.5 }]}
      onPress={() => setWhich(which)}
      disabled={disabled}
    >
      <Icon icon={icon} size={14} />
      <Text size={12.5} color={colors.textSecondary} numberOfLines={1}>
        {label}
      </Text>
      <Icon icon={CaretDown} size={11} />
    </Pressable>
  )

  if (entries.length === 0) {
    return (
      <Screen>
        <Header title="New session" />
        <View style={styles.empty}>
          <Text size={17} weight="semibold">
            No host yet
          </Text>
          <Muted size={13.5} style={{ textAlign: 'center' }}>
            Pair this phone with a computer running BeddCode first.
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

  return (
    <Screen>
      <Header title="New session" subtitle="Nothing runs until you send" />
      <View style={{ flex: 1 }}>
        <View style={styles.center}>
          <View style={{ alignItems: 'center', gap: 6 }}>
            <Text size={21} weight="semibold" style={{ textAlign: 'center' }}>
              What should {agent?.label ?? 'the agent'} work on?
            </Text>
            <Muted size={13} style={{ textAlign: 'center' }}>
              Describe a task, paste an issue link, or ask a question.
            </Muted>
          </View>
          {!agent ? (
            <Muted size={13} style={{ textAlign: 'center' }}>
              {runtime.connection !== 'connected'
                ? 'Connecting to the host…'
                : runtime.loadError && runtime.providers.length === 0
                  ? `${runtime.loadError}. Trying again…`
                  : 'No agent is ready on this host. Install and sign in to one on that computer.'}
            </Muted>
          ) : (
            <Composer
              placeholder="Describe a task, or paste an issue link…"
              onSend={send}
              commands={commands}
              mode={
                mode
                  ? {
                      label: mode.label,
                      onPress: modes.length > 1 ? () => setWhich('mode') : undefined,
                    }
                  : undefined
              }
              model={
                models.length > 0
                  ? {
                      label: model?.label ?? 'Default',
                      detail: effort ? effortLabel(effort) : undefined,
                      onPress: () => setWhich('model'),
                    }
                  : undefined
              }
            />
          )}
          <View style={styles.chips}>
            {entries.length > 1 && chip(Desktop, host ? hostLabel(host) : 'Host', 'host')}
            {chip(Robot, agent?.label ?? 'Agent', 'agent', providers.length === 0)}
            {chip(
              FolderSimple,
              chosenFolder ? (project?.name ?? folderName(chosenFolder)) : 'No project',
              'folder',
            )}
            {chosenFolder && project?.isRepo
              ? chip(
                  GitBranch,
                  worktree ? 'New worktree from main' : 'Work in the folder',
                  'workspace',
                )
              : null}
          </View>
        </View>
      </View>
      <MenuSheet
        visible={which !== null && which !== 'model'}
        title={menu.title}
        items={menu.items}
        onClose={close}
      />
      {agent ? (
        <ModelPicker
          visible={which === 'model'}
          onClose={close}
          provider={agent}
          modelId={modelId}
          effort={effort}
          onChange={(m, e) => {
            setModelId(m)
            setEffort(e)
          }}
        />
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', gap: 16, paddingHorizontal: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 7,
    maxWidth: '100%',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 28,
  },
})
