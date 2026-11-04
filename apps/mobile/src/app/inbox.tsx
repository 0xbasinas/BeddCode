import { inboxThreads, type SessionView } from '@beddcode/client-runtime'
import type { OrchestrationApproval } from '@beddcode/contracts'
import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { hostRequest, useHostStore } from '@/host/store'
import { colors } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Header } from '@/ui/Header'
import { Screen } from '@/ui/Screen'
import { Muted, Text } from '@/ui/Text'

type Scope = { host: string; project: string; sessionId?: string }

export default function InboxScreen() {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [approvals, setApprovals] = useState<Record<string, OrchestrationApproval[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>()
  const [scope, setScope] = useState<Scope>()
  const connected = entries.filter((entry) => runtimes[entry.key]?.connection === 'connected')
  const connectionKey = connected
    .map((entry) => `${entry.key}:${runtimes[entry.key]?.epoch}`)
    .join('|')
  const load = useCallback(async () => {
    await Promise.all(
      connected.map(async ({ key }) => {
        try {
          const items = await hostRequest(key, 'orchestration.approvals.list', {})
          setApprovals((old) => ({
            ...old,
            [key]: items.filter((item) => item.status === 'pending'),
          }))
          setErrors((old) => {
            const next = { ...old }
            delete next[key]
            return next
          })
        } catch (error) {
          setErrors((old) => ({
            ...old,
            [key]: error instanceof Error ? error.message : String(error),
          }))
        }
      }),
    )
    // Reconnects must refresh the queue; ordinary replica updates must not restart the timer.
  }, [connectionKey])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [load])
  const decide = async (host: string, id: string, decision: 'approve' | 'deny') => {
    setBusy(`${host}:${id}`)
    try {
      await hostRequest(
        host,
        decision === 'approve' ? 'orchestration.approvals.approve' : 'orchestration.approvals.deny',
        { id },
      )
      await load()
    } catch (error) {
      setErrors((old) => ({
        ...old,
        [host]: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setBusy(undefined)
    }
  }
  const groups = entries.flatMap((entry) => {
    const sessions = Object.values(runtimes[entry.key]?.replica.sessions ?? {})
    const projects = new Map<string, SessionView[]>()
    for (const session of sessions) {
      const project = session.projectless ? `session:${session.id}` : session.projectPath
      projects.set(project, [...(projects.get(project) ?? []), session])
    }
    return [...projects].map(([project, members]) => ({
      host: entry.key,
      hostName: runtimes[entry.key]?.host?.name ?? entry.name,
      project,
      members,
    }))
  })
  const selected = groups.find((g) => g.host === scope?.host && g.project === scope.project)
  const members =
    selected?.members.filter((s) => !scope?.sessionId || s.id === scope.sessionId) ?? []
  const threads = inboxThreads(members)
  const name = (id: string) => selected?.members.find((s) => s.id === id)?.title ?? id
  return (
    <Screen>
      <Header title="Agent inbox" subtitle="Approvals and message threads" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text weight="semibold">Pending approvals</Text>
        {connected.length < entries.length && (
          <Muted>Some hosts are disconnected; their approvals may be out of date.</Muted>
        )}
        {connected.length === 0 && <Muted>Connect a host to load approvals.</Muted>}
        {entries.map((entry) => (
          <View key={entry.key}>
            {errors[entry.key] && (
              <Text color={colors.danger}>
                {entry.name}: {errors[entry.key]}
              </Text>
            )}
            {runtimes[entry.key]?.connection === 'connected' &&
              (approvals[entry.key] ?? []).map((a) => (
                <View style={styles.card} key={a.id}>
                  <Text weight="semibold">
                    {a.kind === 'spawn' ? 'Start worker' : 'Send message'} · {entry.name}
                  </Text>
                  <Muted>
                    {runtimes[entry.key]?.replica.sessions[a.sessionId]?.title ?? a.sessionId}
                  </Muted>
                  <Text>{a.details}</Text>
                  <Muted>Expires {new Date(a.expiresAt).toLocaleString()}</Muted>
                  <View style={styles.row}>
                    <Button
                      label="Approve"
                      kind="primary"
                      disabled={!!busy}
                      onPress={() => void decide(entry.key, a.id, 'approve')}
                    />
                    <Button
                      label="Deny"
                      disabled={!!busy}
                      onPress={() => void decide(entry.key, a.id, 'deny')}
                    />
                  </View>
                </View>
              ))}
          </View>
        ))}
        {connected.length > 0 &&
          connected.every((e) => approvals[e.key] && approvals[e.key]!.length === 0) && (
            <Muted>No pending approvals.</Muted>
          )}
        <Text weight="semibold">Message threads</Text>
        {!selected ? (
          <>
            <Muted>Choose a project group to see its inbox.</Muted>
            {groups.map((g) => (
              <Pressable
                key={`${g.host}:${g.project}`}
                style={styles.card}
                onPress={() => setScope({ host: g.host, project: g.project })}
                accessibilityRole="button"
              >
                <Text>{g.project.startsWith('session:') ? g.members[0]?.title : g.project}</Text>
                <Muted>
                  {g.hostName} · {g.members.length} sessions
                </Muted>
              </Pressable>
            ))}
          </>
        ) : (
          <>
            <Button label="All groups" onPress={() => setScope(undefined)} />
            <Text>
              {selected.project.startsWith('session:')
                ? selected.members[0]?.title
                : selected.project}{' '}
              · {selected.hostName}
            </Text>
            <ScrollView horizontal contentContainerStyle={styles.row}>
              <Button
                label="Group"
                kind={!scope?.sessionId ? 'primary' : 'secondary'}
                onPress={() => setScope({ host: selected.host, project: selected.project })}
              />
              {selected.members.map((s) => (
                <Button
                  key={s.id}
                  label={s.title}
                  kind={scope?.sessionId === s.id ? 'primary' : 'secondary'}
                  onPress={() =>
                    setScope({ host: selected.host, project: selected.project, sessionId: s.id })
                  }
                />
              ))}
            </ScrollView>
            {threads.length === 0 && <Muted>No agent messages yet.</Muted>}
            {threads.map((thread) => (
              <View style={styles.card} key={thread.threadId}>
                <Text weight="semibold">Thread {thread.threadId}</Text>
                {thread.messages.map((message) => (
                  <View key={message.messageId ?? message.id}>
                    <Muted>
                      {name(message.senderId)} → {name(message.recipientId)}
                    </Muted>
                    <Text>{message.text}</Text>
                  </View>
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  )
}
const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { padding: 12, gap: 8, backgroundColor: colors.card, borderRadius: 8 },
  row: { flexDirection: 'row', gap: 8 },
})
