import { HostClient, type ConnectionState } from '@beddcode/client-runtime/hostClient'
import { applyEvent, emptyReplica, type ReplicaState } from '@beddcode/client-runtime/replica'
import type { HostInfo, RpcMethodName, RpcParams, RpcResult } from '@beddcode/contracts'
import type { HostTarget } from './hosts.ts'

/** One open connection to a host, with every session it has already replayed. */
export interface Conn {
  target: HostTarget
  host: HostInfo
  state(): ReplicaState
  request<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>
  /** Calls back after every change to the sessions; returns an unsubscribe. */
  onChange(listener: (state: ReplicaState) => void): () => void
  close(): void
}

/**
 * Connects, then waits until the host has replayed its whole log, so `state()` is complete. Fails
 * with something a person can act on: not running, wrong address, or a device that was revoked.
 */
export function connect(
  target: HostTarget,
  options: { timeoutMs?: number; createSocket?: (url: string) => WebSocket } = {},
): Promise<Conn> {
  return new Promise((resolve, reject) => {
    let replica = emptyReplica()
    let host: HostInfo | undefined
    let last: ConnectionState = 'connecting'
    const listeners = new Set<(state: ReplicaState) => void>()
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.stop()
      reject(error)
    }
    const client = new HostClient({
      url: target.urls,
      token: target.token,
      expectedHostId: target.hostId,
      createSocket: options.createSocket,
      onEvent(stored) {
        replica = applyEvent(replica, stored)
        listeners.forEach((l) => l(replica))
      },
      onState(state, info) {
        last = state
        if (info) host = info
        if (state === 'denied') {
          fail(
            new Error(
              `${target.name} refused this device. Pair it again with \`beddcode hosts add\`.`,
            ),
          )
        }
      },
      onCaughtUp() {
        if (settled || !host) return
        settled = true
        clearTimeout(timer)
        resolve({
          target,
          host,
          state: () => replica,
          request: (method, params) => client.request(method, params),
          onChange(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          close: () => client.stop(),
        })
      },
    })
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            last === 'connecting' || last === 'reconnecting'
              ? `Could not reach ${target.name} (${target.urls[0]}). Is the host running?`
              : `${target.name} did not answer in time`,
          ),
        ),
      options.timeoutMs ?? 8000,
    )
    client.start()
  })
}

/** Connects to every host at once; hosts that cannot be reached are reported, not fatal. */
export async function connectAll(
  targets: HostTarget[],
  options?: Parameters<typeof connect>[1],
): Promise<{ conns: Conn[]; failures: { target: HostTarget; error: string }[] }> {
  const results = await Promise.allSettled(targets.map((t) => connect(t, options)))
  const conns: Conn[] = []
  const failures: { target: HostTarget; error: string }[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') conns.push(r.value)
    else {
      failures.push({
        target: targets[i]!,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      })
    }
  })
  return { conns, failures }
}
