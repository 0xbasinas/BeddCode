import type { Schedule, ScheduleRun } from '@beddcode/contracts'
import { folderName } from '@beddcode/client-runtime'
import { router } from 'expo-router'
import { Plus, Trash } from 'phosphor-react-native'
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native'

import {
  DAY_NAMES,
  describeTrigger,
  emptyScheduleForm,
  formToInput,
  runLabel,
  scheduleToForm,
  type ScheduleForm,
} from '@/features/schedules/scheduleForm'
import { hostRequest, readyProviders, useHostStore, useRuntime } from '@/host/store'
import { colors, fonts, radius } from '@/theme/tokens'
import { Header } from '@/ui/Header'
import { Icon } from '@/ui/Icon'
import { Screen } from '@/ui/Screen'
import { Faint, Muted, Text } from '@/ui/Text'

function preferredHostKey(
  entries: { key: string; name: string }[],
  runtimes: Record<string, { connection?: string } | undefined>,
) {
  return (
    entries.find((e) => runtimes[e.key]?.connection === 'connected')?.key ?? entries[0]?.key
  )
}

/** The host's scheduled runs: list, pause, run now, and add or edit one. */
export default function SchedulesScreen() {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [hostKey, setHostKey] = useState(() => preferredHostKey(entries, runtimes))
  const [data, setData] = useState<{ schedules: Schedule[]; runs: ScheduleRun[] }>()
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<ScheduleForm>()
  const load = useCallback(async () => {
    if (!hostKey) return
    setError(undefined)
    try {
      setData(await hostRequest(hostKey, 'schedules.list', {}))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [hostKey])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const preferred = preferredHostKey(entries, runtimes)
    if (!preferred) return
    if (!hostKey || !entries.some((e) => e.key === hostKey)) {
      setHostKey(preferred)
      return
    }
    // When the current host is offline and another one is connected, show the live one first.
    if (runtimes[hostKey]?.connection !== 'connected' && preferred !== hostKey) setHostKey(preferred)
  }, [entries, hostKey, runtimes])

  const act = async (run: () => Promise<unknown>) => {
    try {
      await run()
      await load()
    } catch (err) {
      Alert.alert('Could not update the schedule', err instanceof Error ? err.message : String(err))
    }
  }

  if (editing && hostKey) {
    return (
      <Screen>
        <Header title={editing.id ? 'Edit schedule' : 'New schedule'} />
        <ScheduleEditor
          hostKey={hostKey}
          form={editing}
          onChange={setEditing}
          onCancel={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined)
            void load()
          }}
        />
      </Screen>
    )
  }

  return (
    <Screen>
      <Header
        title="Schedules"
        right={
          hostKey ? (
            <Pressable
              onPress={() => setEditing(emptyScheduleForm())}
              accessibilityLabel="New schedule"
            >
              <Icon icon={Plus} size={20} />
            </Pressable>
          ) : undefined
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        {entries.length > 1 ? (
          <View style={styles.chips}>
            {entries.map((e) => {
              const online = runtimes[e.key]?.connection === 'connected'
              const label = runtimes[e.key]?.host?.name ?? e.name
              return (
                <Pressable
                  key={e.key}
                  style={[styles.chip, hostKey === e.key && styles.chipOn]}
                  onPress={() => setHostKey(e.key)}
                >
                  <Text size={12.5}>
                    {label}
                    {online ? '' : ' (offline)'}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        ) : null}
        {error ? (
          <Text size={13} color={colors.danger}>
            {error}
          </Text>
        ) : null}
        {!hostKey ? (
          <Muted size={13.5}>Add a host first.</Muted>
        ) : !data && !error ? (
          <Muted size={13.5}>Loading…</Muted>
        ) : error && !data ? (
          <Muted size={13.5}>Connect to this host to see its schedules.</Muted>
        ) : !data ? null : data.schedules.length === 0 ? (
          <Muted size={13.5}>No schedules yet. Add one to run a prompt on a timer.</Muted>
        ) : (
          data.schedules.map((s) => {
            const last = data.runs.filter((r) => r.scheduleId === s.id)[0]
            return (
              <View key={s.id} style={styles.card}>
                <Pressable onPress={() => setEditing(scheduleToForm(s))}>
                  <Text size={15} weight="medium">
                    {s.name}
                  </Text>
                  <Muted size={12.5}>{describeTrigger(s.trigger)}</Muted>
                  {s.nextRunAt ? (
                    <Faint size={11.5}>
                      Next {new Date(s.nextRunAt).toLocaleString()}
                    </Faint>
                  ) : (
                    <Faint size={11.5}>{s.paused ? 'Paused' : 'No next run'}</Faint>
                  )}
                  {last ? <Faint size={11.5}>Last run: {runLabel(last)}</Faint> : null}
                </Pressable>
                <View style={styles.actions}>
                  <Pressable
                    onPress={() =>
                      void act(() =>
                        hostRequest(hostKey, 'schedules.setPaused', {
                          id: s.id,
                          paused: !s.paused,
                        }),
                      )
                    }
                  >
                    <Muted size={12.5}>{s.paused ? 'Resume' : 'Pause'}</Muted>
                  </Pressable>
                  <Pressable
                    onPress={() => void act(() => hostRequest(hostKey, 'schedules.runNow', { id: s.id }))}
                  >
                    <Muted size={12.5}>Run now</Muted>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      void act(() => hostRequest(hostKey, 'schedules.skipNext', { id: s.id }))
                    }
                  >
                    <Muted size={12.5}>Skip next</Muted>
                  </Pressable>
                  {last?.sessionId ? (
                    <Pressable
                      onPress={() =>
                        router.push({ pathname: '/session/[id]', params: { id: last.sessionId! } })
                      }
                    >
                      <Muted size={12.5}>Open last</Muted>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() =>
                      Alert.alert('Remove this schedule?', s.name, [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Remove',
                          style: 'destructive',
                          onPress: () =>
                            void act(() => hostRequest(hostKey, 'schedules.remove', { id: s.id })),
                        },
                      ])
                    }
                  >
                    <Icon icon={Trash} size={14} color={colors.danger} />
                  </Pressable>
                </View>
              </View>
            )
          })
        )}
      </ScrollView>
    </Screen>
  )
}

function ScheduleEditor({
  hostKey,
  form,
  onChange,
  onCancel,
  onSaved,
}: {
  hostKey: string
  form: ScheduleForm
  onChange(form: ScheduleForm): void
  onCancel(): void
  onSaved(): void
}) {
  const runtime = useRuntime(hostKey)
  const providers = readyProviders(runtime.providers)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<ScheduleForm>) => onChange({ ...form, ...patch })

  const save = async () => {
    const built = formToInput(form)
    if ('error' in built) {
      setError(built.error)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'schedules.save', built.input)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Field label="Name" value={form.name} onChange={(name) => set({ name })} />
      <Field label="Prompt" value={form.prompt} onChange={(prompt) => set({ prompt })} multiline />
      <Text size={12} color={colors.textSecondary}>
        Repeat
      </Text>
      <View style={styles.chips}>
        {(['hourly', 'daily', 'weekly', 'every', 'cron', 'watch'] as const).map((r) => (
          <Pressable
            key={r}
            style={[styles.chip, form.repeat === r && styles.chipOn]}
            onPress={() => set({ repeat: r })}
          >
            <Text size={12.5}>{r}</Text>
          </Pressable>
        ))}
      </View>
      {form.repeat === 'daily' || form.repeat === 'weekly' || form.repeat === 'monthly' ? (
        <Field label="Time (HH:MM)" value={form.time} onChange={(time) => set({ time })} />
      ) : null}
      {form.repeat === 'weekly' ? (
        <View style={styles.chips}>
          {DAY_NAMES.map((name, i) => (
            <Pressable
              key={name}
              style={[styles.chip, form.days.includes(i) && styles.chipOn]}
              onPress={() =>
                set({
                  days: form.days.includes(i)
                    ? form.days.filter((d) => d !== i)
                    : [...form.days, i].sort(),
                })
              }
            >
              <Text size={12.5}>{name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {form.repeat === 'hourly' ? (
        <Field
          label="Minute of the hour"
          value={form.minuteOfHour}
          onChange={(minuteOfHour) => set({ minuteOfHour })}
        />
      ) : null}
      {form.repeat === 'every' ? (
        <Field label="Every N minutes" value={form.minutes} onChange={(minutes) => set({ minutes })} />
      ) : null}
      {form.repeat === 'cron' ? (
        <Field label="Cron expression" value={form.expr} onChange={(expr) => set({ expr })} />
      ) : null}
      {form.repeat === 'watch' ? (
        <>
          <Field label="File glob" value={form.glob} onChange={(glob) => set({ glob })} />
          <Field
            label="Debounce (minutes)"
            value={form.debounceMinutes}
            onChange={(debounceMinutes) => set({ debounceMinutes })}
          />
        </>
      ) : null}
      <Field
        label="Timezone (optional IANA)"
        value={form.timezone}
        onChange={(timezone) => set({ timezone })}
      />
      <Text size={12} color={colors.textSecondary}>
        Agent
      </Text>
      <View style={styles.chips}>
        {providers.map((p) => (
          <Pressable
            key={p.id}
            style={[styles.chip, form.instanceId === p.id && styles.chipOn]}
            onPress={() => set({ instanceId: p.id })}
          >
            <Text size={12.5}>{p.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text size={12} color={colors.textSecondary}>
        Folder
      </Text>
      <View style={styles.chips}>
        <Pressable
          style={[styles.chip, form.cwd === '' && styles.chipOn]}
          onPress={() => set({ cwd: '' })}
        >
          <Text size={12.5}>No project</Text>
        </Pressable>
        {runtime.projects.map((p) => (
          <Pressable
            key={p.path}
            style={[styles.chip, form.cwd === p.path && styles.chipOn]}
            onPress={() => set({ cwd: p.path })}
          >
            <Text size={12.5}>{p.name || folderName(p.path)}</Text>
          </Pressable>
        ))}
      </View>
      <RowSwitch
        label="Enabled"
        value={!form.id ? form.enabled : !false}
        onValueChange={(enabled) => set({ enabled })}
      />
      {error ? (
        <Text size={13} color={colors.danger}>
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable onPress={onCancel} disabled={busy}>
          <Muted size={14}>Cancel</Muted>
        </Pressable>
        <Pressable onPress={() => void save()} disabled={busy}>
          <Text size={14}>{busy ? 'Saving…' : 'Save'}</Text>
        </Pressable>
      </View>
    </ScrollView>
  )
}

function Field({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string
  value: string
  onChange(value: string): void
  multiline?: boolean
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text size={12} color={colors.textSecondary}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        placeholderTextColor={colors.faint}
        style={[styles.input, multiline && { minHeight: 80, textAlignVertical: 'top' }]}
      />
    </View>
  )
}

function RowSwitch({
  label,
  value,
  onValueChange,
}: {
  label: string
  value: boolean
  onValueChange(v: boolean): void
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text size={13.5}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: colors.accent, false: colors.raised }} />
    </View>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 14, paddingBottom: 40 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.active },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    padding: 12,
    gap: 8,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'center' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.control,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
})
