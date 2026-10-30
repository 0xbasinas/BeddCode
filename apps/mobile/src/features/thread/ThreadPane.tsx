import { doneMenuAction, effortLabel, endedByDecline, folderName } from '@beddcode/client-runtime'
import { Checks, DotsThree, Stop as StopIcon, ArrowUUpLeft } from 'phosphor-react-native'
import { now } from '@beddcode/client-runtime'
import { useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { Composer } from '@/features/composer/Composer'
import { ModelPicker } from '@/features/composer/ModelPicker'
import {
  answerQuestion,
  approve,
  dequeue,
  interrupt,
  prompt,
  recordMetric,
  setMode,
  setSessionDone,
  setSessionModel,
  useHostStore,
  useSession,
  useSessionHostKey,
} from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Header } from '@/ui/Header'
import { Icon } from '@/ui/Icon'
import { MenuSheet, type MenuItem } from '@/ui/MenuSheet'
import { Faint, Muted, Text } from '@/ui/Text'
import { attachBase64, EMPTY_ATTACHMENTS, useAttachments } from '@/host/attachments'
import type { Pane } from '@/features/panes/PaneBar'
import * as ImagePicker from 'expo-image-picker'
import { Camera, Image as ImageIcon, FolderSimple, TerminalWindow } from 'phosphor-react-native'
import { Transcript } from './Transcript'
import { StartedByBanner } from './AgentToolCard'

/** The conversation with the agent: transcript, anything it waits on, and the composer. */
export function ThreadPane({
  sessionId,
  onOpenPane,
}: {
  sessionId: string
  onOpenPane(pane: Pane): void
}) {
  const session = useSession(sessionId)
  const hostKey = useSessionHostKey(sessionId)
  const openedAt = useRef(now())
  // Only the parts of the host this screen shows, so another session streaming on the same host
  // does not redraw this one.
  const providers = useHostStore((s) => (hostKey ? s.runtimes[hostKey]?.providers : undefined))
  const synced = useHostStore((s) => (hostKey ? s.runtimes[hostKey]?.synced : false))
  const hostName =
    useHostStore((s) => (hostKey ? s.runtimes[hostKey]?.host?.name : undefined)) ?? 'Host'
  const [menu, setMenu] = useState(false)
  const [modeMenu, setModeMenu] = useState(false)
  const [attachMenu, setAttachMenu] = useState(false)
  const [modelMenu, setModelMenu] = useState(false)
  const draft = useAttachments((s) => s.drafts[sessionId]) ?? EMPTY_ATTACHMENTS

  if (!session) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="Session" />
        <View style={styles.missing}>
          <Muted size={13.5} style={{ textAlign: 'center' }}>
            {synced ? 'This session is not available.' : 'Loading…'}
          </Muted>
        </View>
      </View>
    )
  }

  const agent = providers?.find((p) => p.id === session.instanceId)
  const hasModels = (agent?.capabilities.models?.length ?? 0) > 0
  const subtitle = [
    hostName,
    session.projectless ? 'No project' : folderName(session.projectPath),
    session.branch,
  ]
    .filter(Boolean)
    .join(' · ')
  const running = session.status === 'running'
  const modes = session.modes ?? []
  const currentMode = modes.find((m) => m.id === session.currentModeId)
  const contextPct =
    session.context && session.context.size > 0
      ? Math.min(100, Math.round((session.context.used / session.context.size) * 100))
      : undefined

  const pickPhoto = async (source: 'library' | 'camera') => {
    if (source === 'camera') {
      const allowed = await ImagePicker.requestCameraPermissionsAsync()
      if (!allowed.granted) return
    }
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      base64: true,
      quality: 0.8,
    }
    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync({ ...options, allowsMultipleSelection: true })
    if (result.canceled || !hostKey) return
    for (const asset of result.assets) {
      if (!asset.base64) continue
      await attachBase64(
        hostKey,
        session.id,
        asset.fileName ?? 'photo.jpg',
        asset.base64,
        asset.fileSize ?? asset.base64.length,
      )
    }
  }

  const action = doneMenuAction(session)
  const items: MenuItem[] = [
    {
      id: 'done',
      label: action.label,
      hint: action.hint,
      icon: action.kind === 'restore' ? ArrowUUpLeft : Checks,
      disabled: action.kind === 'busy',
      onSelect: () => void setSessionDone(session.id, action.kind === 'file'),
    },
    ...(running
      ? [
          {
            id: 'stop',
            label: 'Stop the agent',
            icon: StopIcon,
            danger: true,
            onSelect: () => void interrupt(session.id),
          },
        ]
      : []),
  ]

  return (
    <View style={{ flex: 1 }}>
      <Header
        title={session.title}
        subtitle={subtitle}
        right={
          <Pressable hitSlop={10} onPress={() => setMenu(true)} accessibilityLabel="More">
            <Icon icon={DotsThree} size={22} weight="bold" />
          </Pressable>
        }
      />
      <View style={{ flex: 1 }}>
        <Transcript
          onFirstLayout={() => {
            if (hostKey)
              recordMetric(hostKey, 'thread.open.ms', now() - openedAt.current, {
                rows:
                  session.items.length < 50
                    ? 'lt50'
                    : session.items.length < 500
                      ? 'lt500'
                      : 'many',
              })
          }}
          session={session}
          cwd={session.cwd}
          hostKey={hostKey}
          onApprove={(requestId, optionId) => approve(session.id, requestId, optionId)}
          onAnswer={(requestId, answers) => answerQuestion(session.id, requestId, answers)}
          header={
            <View style={{ alignItems: 'center', paddingBottom: 4 }}>
              <Faint size={12}>
                Started{' '}
                {new Date(session.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {session.worktree ? ` · worktree from ${session.worktree.baseBranch}` : ''}
              </Faint>
              {session.parent ? (
                <View style={{ alignSelf: 'stretch' }}>
                  <StartedByBanner session={session} hostKey={hostKey} />
                </View>
              ) : null}
            </View>
          }
        />
        {session.queue.length > 0 && (
          <View style={styles.queue}>
            {session.queue.map((q) => (
              <View key={q.queueId} style={styles.queued}>
                <Text size={12.5} color={colors.muted} numberOfLines={1} style={{ flex: 1 }}>
                  {q.text}
                </Text>
                <Pressable onPress={() => void dequeue(session.id, q.queueId, 'steer')}>
                  <Text size={12.5} color={colors.accent}>
                    Send now
                  </Text>
                </Pressable>
                <Pressable onPress={() => void dequeue(session.id, q.queueId, 'cancel')}>
                  <Text size={12.5} color={colors.muted}>
                    Cancel
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={styles.composer}>
          <Composer
            placeholder={
              endedByDecline(session)
                ? `You declined. Tell ${agent?.label ?? 'the agent'} what to do instead…`
                : `Reply to ${agent?.label ?? 'the agent'}…`
            }
            running={running}
            onStop={() => void interrupt(session.id)}
            onSend={async (text, ids) => {
              await prompt(session.id, text, ids)
              useAttachments.getState().remove(
                session.id,
                draft.filter((a) => a.id && ids.includes(a.id)).map((a) => a.key),
              )
            }}
            attachments={draft}
            hostKey={hostKey}
            commands={session.commands}
            onRemoveAttachment={(key) => useAttachments.getState().remove(session.id, [key])}
            onAttach={() => setAttachMenu(true)}
            mode={
              currentMode || modes.length > 0
                ? {
                    label: currentMode?.label ?? 'Mode',
                    onPress: modes.length > 1 ? () => setModeMenu(true) : undefined,
                  }
                : undefined
            }
            model={
              hasModels || session.model
                ? {
                    label:
                      agent?.capabilities.models?.find((m) => m.id === session.model)?.label ??
                      session.model ??
                      'Default model',
                    detail: session.effort ? effortLabel(session.effort) : undefined,
                    onPress: hasModels ? () => setModelMenu(true) : undefined,
                  }
                : undefined
            }
            context={contextPct !== undefined ? `Context ${contextPct}%` : undefined}
          />
        </View>
      </View>
      {agent && hasModels ? (
        <ModelPicker
          visible={modelMenu}
          onClose={() => setModelMenu(false)}
          provider={agent}
          modelId={session.model}
          effort={session.effort}
          onChange={(model, effort) => void setSessionModel(session.id, model, effort)}
        />
      ) : null}
      <MenuSheet
        visible={attachMenu}
        title="Add context"
        onClose={() => setAttachMenu(false)}
        items={[
          {
            id: 'photo',
            label: 'Photo from your library',
            icon: ImageIcon,
            onSelect: () => void pickPhoto('library'),
          },
          {
            id: 'camera',
            label: 'Take a photo',
            icon: Camera,
            onSelect: () => void pickPhoto('camera'),
          },
          {
            id: 'files',
            label: 'File from the project',
            hint: 'Open Files and tap Attach',
            icon: FolderSimple,
            onSelect: () => onOpenPane('files'),
          },
          {
            id: 'term',
            label: 'Text from the terminal',
            hint: 'Select it in Terminal',
            icon: TerminalWindow,
            onSelect: () => onOpenPane('terminal'),
          },
        ]}
      />
      <MenuSheet
        visible={menu}
        title={session.title}
        items={items}
        onClose={() => setMenu(false)}
      />
      <MenuSheet
        visible={modeMenu}
        title="How much it asks"
        onClose={() => setModeMenu(false)}
        items={modes.map((m) => ({
          id: m.id,
          label: m.label,
          hint: m.description,
          danger: m.dangerous,
          selected: m.id === session.currentModeId,
          onSelect: () => void setMode(session.id, m.id),
        }))}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  composer: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6 },
  queue: { paddingHorizontal: 16, gap: 6, paddingBottom: 4 },
  queued: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.raised,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
})
