import type { TerminalInfo } from '@beddcode/contracts'
import { Paperclip, Plus, TerminalWindow, Trash } from 'phosphor-react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { attachText } from '@/host/attachments'
import { hostRequest, useRuntime } from '@/host/store'
import { useWorkspace } from '@/host/workspace'
import { colors, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'
import { TerminalSurface, type TerminalHandle } from './TerminalSurface'
import { sendKeys } from './useTerminalBridge'

/** Preserve provenance without guessing which command produced an arbitrary scrollback selection. */
function terminalContext(
  session: { id: string; title: string },
  terminal: { id: string; shell: string; cwd: string },
  text: string,
): string {
  return [
    'Selected terminal text',
    `Session: ${session.title} (${session.id})`,
    `Terminal: ${terminal.id}`,
    `Shell: ${terminal.shell}`,
    `Working directory: ${terminal.cwd}`,
    `Captured: ${new Date().toISOString()}`,
    '',
    '--- Selection ---',
    text,
  ].join('\n')
}

const KEYS: { label: string; data?: string; ctrl?: boolean }[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', ctrl: true },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: '|', data: '|' },
  { label: '~', data: '~' },
  { label: '/', data: '/' },
  { label: '-', data: '-' },
]

/** What a tab is called: the user's name for it, else what it was opened for, else its shell. */
function tabLabel(t: Pick<TerminalInfo, 'name' | 'title' | 'shell'>): string {
  return t.name || t.title || t.shell
}

/** Shells running in the session's folder on its host, one tab each. */
export function TerminalPane({
  sessionId,
  active,
  onAttached,
}: {
  sessionId: string
  active: boolean
  onAttached(): void
}) {
  const { session, hostKey, cwd } = useWorkspace(sessionId)
  const runtime = useRuntime(hostKey)
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null)
  const [current, setCurrent] = useState<string>()
  const [error, setError] = useState<string>()
  const [selection, setSelection] = useState('')
  const [renaming, setRenaming] = useState<string>()
  const draft = useRef('')
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  ctrlRef.current = ctrl
  const surface = useRef<TerminalHandle>(null)

  useEffect(() => {
    if (!hostKey || !cwd) return
    let cancelled = false
    hostRequest(hostKey, 'terminals.list', { cwd }).then(
      (list) => {
        if (cancelled) return
        setTerminals(list)
        setCurrent((cur) => (cur && list.some((t) => t.id === cur) ? cur : list[0]?.id))
      },
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, cwd, runtime.epoch])

  const create = useCallback(async () => {
    if (!hostKey || !cwd) return
    setError(undefined)
    try {
      const info = await hostRequest(hostKey, 'terminals.create', { cwd })
      setTerminals((list) => [...(list ?? []), info])
      setCurrent(info.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [hostKey, cwd])

  const rename = async (id: string, name: string) => {
    setRenaming(undefined)
    if (!hostKey) return
    const before = terminals?.find((t) => t.id === id)
    if (!before || name.trim() === tabLabel(before)) return
    try {
      const info = await hostRequest(hostKey, 'terminals.rename', {
        id,
        // Back to the default name also when the user typed exactly that.
        name: name.trim() === (before.title ?? before.shell) ? '' : name,
      })
      setTerminals((list) => (list ?? []).map((t) => (t.id === id ? info : t)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const takeCtrl = useCallback(() => {
    const armed = ctrlRef.current
    if (armed) setCtrl(false)
    return armed
  }, [])

  if (!session || !hostKey || !cwd) {
    return (
      <View style={styles.center}>
        <Muted size={13.5}>Loading…</Muted>
      </View>
    )
  }

  const close = async (id: string) => {
    await hostRequest(hostKey, 'terminals.close', { id }).catch(() => {})
    setTerminals((list) => {
      const next = (list ?? []).filter((t) => t.id !== id)
      setCurrent((cur) => (cur === id ? next.at(-1)?.id : cur))
      return next
    })
  }

  const terminal = terminals?.find((t) => t.id === current)
  const folder = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

  const attachSelection = () => {
    if (!terminal || !selection.trim()) return
    void attachText(
      hostKey,
      sessionId,
      'terminal-selection.txt',
      terminalContext({ id: session.id, title: session.title }, terminal, selection),
    )
    surface.current?.clearSelection()
    setSelection('')
    onAttached()
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.head}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, flexShrink: 1 }}>
          <Text size={15} weight="medium">
            Terminal
          </Text>
          <Faint size={13} numberOfLines={1} style={{ flexShrink: 1 }}>
            {session.branch ?? folder}
          </Faint>
        </View>
        <View style={{ flexDirection: 'row', gap: 18 }}>
          <Pressable hitSlop={8} onPress={() => void create()} accessibilityLabel="New terminal">
            <Icon icon={Plus} size={20} />
          </Pressable>
          <Pressable
            hitSlop={8}
            disabled={!terminal}
            onPress={() => terminal && void close(terminal.id)}
            accessibilityLabel="Close terminal"
            style={!terminal && { opacity: 0.4 }}
          >
            <Icon icon={Trash} size={19} />
          </Pressable>
        </View>
      </View>

      {error ? (
        <Text size={12.5} color={colors.danger} style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
          {error}
        </Text>
      ) : null}

      {terminals === null && !error ? (
        <View style={styles.center}>
          <Muted size={13.5}>Loading…</Muted>
        </View>
      ) : terminals?.length === 0 ? (
        <View style={styles.center}>
          <Icon icon={TerminalWindow} size={30} />
          <Text size={16} weight="semibold" style={{ marginTop: 10 }}>
            No terminal yet
          </Text>
          <Muted size={13} style={{ textAlign: 'center', marginBottom: 14 }}>
            Start a shell in {folder} to run commands.
          </Muted>
          <Button label="New terminal" kind="primary" onPress={() => void create()} />
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0 }}
            contentContainerStyle={styles.tabs}
          >
            {terminals?.map((t) => (
              <Pressable
                key={t.id}
                style={[styles.tab, t.id === current && { backgroundColor: colors.active }]}
                onPress={() => setCurrent(t.id)}
                onLongPress={() => {
                  draft.current = tabLabel(t)
                  setRenaming(t.id)
                }}
                accessibilityHint="Long press to rename"
              >
                <Icon
                  icon={TerminalWindow}
                  size={14}
                  color={t.id === current ? colors.text : colors.muted}
                />
                {renaming === t.id ? (
                  <TextInput
                    autoFocus
                    selectTextOnFocus
                    maxLength={40}
                    defaultValue={tabLabel(t)}
                    placeholder={t.title ?? t.shell}
                    placeholderTextColor={colors.muted}
                    returnKeyType="done"
                    accessibilityLabel="Terminal name"
                    style={styles.nameInput}
                    onSubmitEditing={() => void rename(t.id, draft.current)}
                    onChangeText={(v) => (draft.current = v)}
                    onBlur={() => void rename(t.id, draft.current)}
                  />
                ) : (
                  <Text size={13} color={t.id === current ? colors.text : colors.muted}>
                    {tabLabel(t)}
                    {t.exited !== undefined ? ' (exited)' : ''}
                  </Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
          <View style={styles.surface}>
            {terminals?.map((t) => (
              <View
                key={t.id}
                style={[StyleSheet.absoluteFill, t.id !== current && { display: 'none' }]}
              >
                {/* Only the current shell is attached; the others reattach (and replay) when picked. */}
                {t.id === current ? (
                  <TerminalSurface
                    ref={surface}
                    hostKey={hostKey}
                    id={t.id}
                    onSelection={setSelection}
                    takeCtrl={takeCtrl}
                  />
                ) : null}
              </View>
            ))}
          </View>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0 }}
            contentContainerStyle={styles.keys}
          >
            {selection.trim() ? (
              <Pressable
                style={[styles.key, { backgroundColor: colors.infoSoft }]}
                onPress={attachSelection}
              >
                <Icon icon={Paperclip} size={14} color={colors.info} />
                <Text size={12.5} color={colors.info}>
                  Attach selection
                </Text>
              </Pressable>
            ) : null}
            {KEYS.map((k) => (
              <Pressable
                key={k.label}
                style={[styles.key, k.ctrl && ctrl && { backgroundColor: colors.accentSoft }]}
                onPress={() => {
                  if (k.ctrl) setCtrl((v) => !v)
                  else if (terminal && k.data) sendKeys(hostKey, terminal.id, k.data)
                  if (active) surface.current?.focus()
                }}
              >
                <Text
                  size={12.5}
                  mono
                  color={k.ctrl && ctrl ? colors.accent : colors.textSecondary}
                >
                  {k.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}
      <View style={styles.footer}>
        <Faint size={11} numberOfLines={1}>
          {terminal ? `${terminal.shell} · ${terminal.cwd}` : cwd}
        </Faint>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  nameInput: { minWidth: 70, padding: 0, fontSize: 13, color: colors.text },
  tabs: { gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.control,
  },
  surface: {
    flex: 1,
    marginHorizontal: 10,
    borderRadius: radius.panel,
    overflow: 'hidden',
    backgroundColor: colors.terminal,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  keys: { gap: 6, paddingHorizontal: 10, paddingVertical: 8 },
  key: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 38,
    minHeight: 34,
    paddingHorizontal: 12,
    justifyContent: 'center',
    backgroundColor: colors.raised,
    borderRadius: 7,
  },
  footer: { paddingHorizontal: 16, paddingBottom: 6 },
})
