import { folderName } from '@beddcode/client-runtime'
import type { RpcResult } from '@beddcode/contracts'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { hostRequest, readyProviders, useHostStore, useRuntime } from '@/host/store'
import { colors, fonts, radius } from '@/theme/tokens'
import { Header } from '@/ui/Header'
import { Screen } from '@/ui/Screen'
import { Faint, Muted, Text } from '@/ui/Text'

type Overview = RpcResult<'mcp.overview'>

/** MCP servers the agents on this host can use, plus a way to add or remove one. */
export default function McpScreen() {
  const entries = useHostStore((s) => s.entries)
  const [hostKey, setHostKey] = useState(entries[0]?.key)
  const runtime = useRuntime(hostKey)
  const providers = readyProviders(runtime.providers)
  const [cwd, setCwd] = useState<string>('')
  const [overview, setOverview] = useState<Overview>()
  const [error, setError] = useState<string>()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<'http' | 'sse'>('http')
  const [instanceId, setInstanceId] = useState<string>()
  const [busy, setBusy] = useState(false)

  const agent = providers.find((p) => p.id === instanceId) ?? providers[0]

  const load = useCallback(async () => {
    if (!hostKey) return
    setError(undefined)
    try {
      setOverview(await hostRequest(hostKey, 'mcp.overview', { cwd: cwd || undefined }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [hostKey, cwd])
  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    if (!hostKey || !agent) return
    if (!name.trim() || !url.trim()) {
      setError('A name and URL are needed.')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'mcp.add', {
        instanceId: agent.id,
        cwd: cwd || undefined,
        server: { name: name.trim(), transport, url: url.trim() },
      })
      setName('')
      setUrl('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = (serverName: string, instance: string) =>
    Alert.alert('Remove this server?', serverName, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            if (!hostKey) return
            try {
              await hostRequest(hostKey, 'mcp.remove', {
                instanceId: instance,
                cwd: cwd || undefined,
                name: serverName,
              })
              await load()
            } catch (err) {
              Alert.alert('Could not remove it', err instanceof Error ? err.message : String(err))
            }
          })(),
      },
    ])

  return (
    <Screen>
      <Header title="MCP servers" subtitle="Tools the agents can call" />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {entries.length > 1 ? (
          <View style={styles.chips}>
            {entries.map((e) => (
              <Pressable
                key={e.key}
                style={[styles.chip, hostKey === e.key && styles.chipOn]}
                onPress={() => setHostKey(e.key)}
              >
                <Text size={12.5}>{e.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={styles.chips}>
          <Pressable
            style={[styles.chip, cwd === '' && styles.chipOn]}
            onPress={() => setCwd('')}
          >
            <Text size={12.5}>Host default</Text>
          </Pressable>
          {runtime.projects.map((p) => (
            <Pressable
              key={p.path}
              style={[styles.chip, cwd === p.path && styles.chipOn]}
              onPress={() => setCwd(p.path)}
            >
              <Text size={12.5}>{p.name || folderName(p.path)}</Text>
            </Pressable>
          ))}
        </View>
        {error ? (
          <Text size={13} color={colors.danger}>
            {error}
          </Text>
        ) : null}
        {overview?.servers.map((s) => (
          <View key={s.name} style={styles.card}>
            <Text size={15} weight="medium">
              {s.name}
              {s.mismatch ? <Faint size={12}> · agents disagree</Faint> : null}
            </Text>
            {s.agents.map((a) => (
              <View key={a.instanceId} style={styles.row}>
                <Muted size={12.5} style={{ flex: 1 }}>
                  {a.label}
                  {a.server.transport ? ` · ${a.server.transport}` : ''}
                </Muted>
                <Pressable onPress={() => remove(s.name, a.instanceId)}>
                  <Text size={12} color={colors.danger}>
                    Remove
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        ))}
        {overview && overview.servers.length === 0 ? (
          <Muted size={13.5}>No MCP servers yet.</Muted>
        ) : null}
        {overview?.errors.map((e) => (
          <Text key={e.instanceId} size={12} color={colors.danger}>
            {e.label}: {e.error}
          </Text>
        ))}
        <View style={styles.card}>
          <Text size={15} weight="medium">
            Add a server
          </Text>
          <Muted size={12}>HTTP or SSE URL, added for one agent. Stdio servers are set on the computer.</Muted>
          <View style={styles.chips}>
            {providers.map((p) => (
              <Pressable
                key={p.id}
                style={[styles.chip, (instanceId ?? agent?.id) === p.id && styles.chipOn]}
                onPress={() => setInstanceId(p.id)}
              >
                <Text size={12.5}>{p.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.chips}>
            {(['http', 'sse'] as const).map((t) => (
              <Pressable
                key={t}
                style={[styles.chip, transport === t && styles.chipOn]}
                onPress={() => setTransport(t)}
              >
                <Text size={12.5}>{t.toUpperCase()}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Name (letters, digits, dots, dashes)"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            style={styles.input}
          />
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://…"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable onPress={() => void add()} disabled={busy || !agent} style={styles.btn}>
            <Text size={13.5}>{busy ? 'Adding…' : 'Add server'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
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
    padding: 14,
    gap: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    borderRadius: radius.control,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  btn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.hover,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
})
