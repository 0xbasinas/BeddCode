import { readLines } from '../lines.ts'
import type { Logger } from '../log.ts'
import type { Transport } from '../jsonrpc.ts'
import type { AgentMeta, SupervisedProcess, SupervisedSpawn, SupervisorClient } from './client.ts'

/** A JSON-RPC transport whose agent process is owned by the supervisor. */
export interface SupervisedTransport extends Transport {
  /** Let go of the agent without ending it (the host is stopping; a later host takes over). */
  detach(): void
  /** What the previous host stored with the agent, when this transport took one over. */
  readonly meta: AgentMeta | undefined
  /** First JSON-RPC request id to use: high after a reattach, so answers meant for the previous host cannot match. */
  readonly idStart: number | undefined
  /** True when the agent was already running when this transport was made. */
  readonly reattached: boolean
  setMeta(meta: AgentMeta): void
  /** Set by the session: true when everything received so far has been processed. */
  setAckGate(gate: () => boolean): void
}

/** Wraps a supervised process as the transport the JSON-RPC sessions already speak through. */
export function createSupervisedTransport(
  proc: SupervisedProcess,
  options: { reattached: boolean; log?: Logger; name?: string },
): SupervisedTransport {
  const name = options.name ?? 'agent'
  proc.stdin.on('error', () => {})
  return {
    send: (line) => {
      if (!proc.stdin.writable) return
      try {
        proc.stdin.write(`${line}\n`)
      } catch (err) {
        options.log?.warn(`could not write to ${name}`, err)
      }
    },
    onLine: (handler) =>
      readLines(proc.stdout, handler, {
        onError: (err) => options.log?.error(`could not handle a line from ${name}`, err),
      }),
    onClose: (handler) => {
      let fired = false
      proc.once('exit', () => {
        if (fired) return
        fired = true
        handler()
      })
    },
    close: () => void proc.kill(),
    stderrTail: () => proc.stderrTail.trim(),
    detach: () => proc.detach(),
    get meta() {
      return proc.meta
    },
    reattached: options.reattached,
    idStart: options.reattached ? 1_000_000 + (Date.now() % 1_000_000_000) : undefined,
    setMeta: (meta) => proc.setMeta(meta),
    setAckGate: (gate) => {
      proc.ackGate = gate
    },
  }
}

/** The transport as a supervised one, when it is. */
export function asSupervised(transport: Transport): SupervisedTransport | undefined {
  return typeof (transport as Partial<SupervisedTransport>).setMeta === 'function'
    ? (transport as SupervisedTransport)
    : undefined
}

/**
 * A transport to an agent under the supervisor: the one still running for `id` when `reattach` is
 * asked for and there is one, otherwise a new agent started by the supervisor.
 */
export async function openSupervisedTransport(
  client: SupervisorClient,
  id: string,
  spec: SupervisedSpawn,
  options: { reattach?: boolean; log?: Logger; name?: string } = {},
): Promise<SupervisedTransport> {
  if (options.reattach) {
    const proc = await client.attach(id).catch((err: unknown) => {
      options.log?.warn(`could not reattach ${id}; starting a new agent`, err)
      return undefined
    })
    if (proc) {
      options.log?.info(`reattached ${id} to its running agent (pid ${proc.pid})`)
      return createSupervisedTransport(proc, { reattached: true, ...options })
    }
  }
  const proc = client.spawn(id, { ...spec, protocol: 'jsonrpc' }, {})
  return createSupervisedTransport(proc, { reattached: false, ...options })
}
