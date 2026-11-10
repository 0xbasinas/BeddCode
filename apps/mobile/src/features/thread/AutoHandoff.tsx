import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { chooseHandoffAgent, detectHandoffTrigger, type SessionView } from '@beddcode/client-runtime'

import { policyFor, useAutoHandoff } from '@/host/autoHandoff'
import { prepareHandoff } from '@/host/handoff'
import { createSession, prompt, refreshProviders, useHostStore } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Text } from '@/ui/Text'

interface Pending {
  hostKey: string
  session: SessionView
  target: string
  label: string
  reason: string
  mode: 'ask' | 'auto'
}

/**
 * Watches for a turn that failed in a way another agent can continue, then starts that handoff.
 * This runs while the phone app is open, including in the background of any screen.
 */
export function AutoHandoff() {
  const [pending, setPending] = useState<Pending>()
  const [seconds, setSeconds] = useState(10)
  const [error, setError] = useState<string>()
  const [createdId, setCreatedId] = useState<string>()
  const active = useRef(false)
  const seen = useRef(new Map<string, Set<string>>())

  useEffect(
    () =>
      useHostStore.subscribe((state) => {
        for (const [hostKey, runtime] of Object.entries(state.runtimes)) {
          if (!runtime.synced || runtime.connection !== 'connected') continue
          const previous = seen.current.get(hostKey)
          const current = new Set<string>()
          for (const session of Object.values(runtime.replica.sessions)) {
            if (session.turnStartedAt === undefined) {
              for (const item of session.items)
                if (item.kind === 'error') current.add(`${session.id}:${item.id}`)
            }
          }
          seen.current.set(hostKey, current)
          if (!previous || active.current) continue
          for (const session of Object.values(runtime.replica.sessions)) {
            if (
              session.status !== 'failed' ||
              session.turnStartedAt !== undefined ||
              session.handoffsTo?.length
            )
              continue
            const errors = session.items.filter((item) => item.kind === 'error')
            const latest = errors.at(-1)
            if (!latest || previous.has(`${session.id}:${latest.id}`)) continue
            const source = runtime.providers.find((p) => p.id === session.instanceId)
            if (!source) continue
            const reason = detectHandoffTrigger(source.kind, latest.message, errors.length)
            if (!reason) continue
            const policy = policyFor(
              useAutoHandoff.getState().hosts,
              hostKey,
              session.projectless ? undefined : session.projectPath,
            )
            const failed: Record<string, number> = { [session.instanceId]: Date.now() }
            let parent = session.handoffFrom?.sessionId
            let child = session.id
            let hops = 0
            const visited = new Set<string>()
            while (parent && !visited.has(parent)) {
              visited.add(parent)
              hops++
              const ancestor = runtime.replica.sessions[parent]
              if (!ancestor) break
              failed[ancestor.instanceId] =
                ancestor.handoffsTo?.find((h) => h.sessionId === child)?.at ?? ancestor.updatedAt
              child = ancestor.id
              parent = ancestor.handoffFrom?.sessionId
            }
            const target = chooseHandoffAgent(policy, runtime.providers, failed, hops)
            if (!target || policy.mode === 'off') continue
            active.current = true
            setSeconds(policy.mode === 'ask' ? 10 : 0)
            setPending({
              hostKey,
              session,
              target: target.id,
              label: target.label,
              reason: reason.slice(0, 1000),
              mode: policy.mode,
            })
            return
          }
        }
      }),
    [],
  )

  useEffect(() => {
    if (!pending) return
    if (seconds > 0) {
      const timer = setTimeout(() => setSeconds((s) => s - 1), 1000)
      return () => clearTimeout(timer)
    }
    let cancelled = false
    void (async () => {
      try {
        const note = await prepareHandoff(
          pending.hostKey,
          pending.session,
          pending.label,
          `Automatic handoff: ${pending.reason}`,
        )
        if (cancelled) return
        await refreshProviders(pending.hostKey)
        const runtime = useHostStore.getState().runtimes[pending.hostKey]
        if (!runtime?.providers.some((p) => p.id === pending.target && p.status === 'ready'))
          throw new Error('The fallback agent is no longer ready.')
        if (cancelled) return
        const id = await createSession(pending.hostKey, {
          instanceId: pending.target,
          handoffFrom: pending.session.id,
          handoffReason: pending.reason,
        })
        await prompt(id, note, undefined, undefined, `automatic-handoff:${pending.session.id}`)
        setCreatedId(id)
        setPending(undefined)
        active.current = false
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPending(undefined)
        active.current = false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pending, seconds])

  if (!pending && !error && !createdId) return null
  return (
    <View style={styles.banner} accessibilityRole="alert">
      {pending ? (
        <>
          <Text size={13} style={{ flex: 1 }}>
            Handing off to {pending.label} because {pending.reason}
            {seconds > 0 ? ` · continuing in ${seconds}s` : '…'}
          </Text>
          {seconds > 0 ? (
            <Pressable
              onPress={() => {
                setPending(undefined)
                active.current = false
              }}
              accessibilityRole="button"
              accessibilityLabel="Cancel handoff"
            >
              <Text size={13} color={colors.textSecondary}>
                Cancel
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : error ? (
        <>
          <Text size={13} style={{ flex: 1 }} color={colors.danger}>
            {error}
          </Text>
          <Pressable onPress={() => setError(undefined)} accessibilityRole="button">
            <Text size={13} color={colors.textSecondary}>
              Dismiss
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text size={13} style={{ flex: 1 }}>
            The new session is ready.
          </Text>
          <Pressable
            onPress={() => {
              if (createdId) router.push({ pathname: '/session/[id]', params: { id: createdId } })
              setCreatedId(undefined)
            }}
            accessibilityRole="button"
          >
            <Text size={13} color={colors.textSecondary}>
              Open
            </Text>
          </Pressable>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.infoPanel,
    borderColor: colors.infoBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control,
  },
})
