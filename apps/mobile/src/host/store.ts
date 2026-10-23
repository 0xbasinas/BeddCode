import { useMemo } from 'react'
import { AppState } from 'react-native'
import { create } from 'zustand'
import {
  HostClient,
  applyEvent,
  retryWhileCurrent,
  emptyReplica,
  loadRemoteHosts,
  saveRemoteHosts,
  upsertHost,
  type ConnectionState,
  type HostEntry,
  type ReplicaState,
  type SessionView,
} from '@beddcode/client-runtime'
import type {
  ClientFrame,
  HostInfo,
  Project,
  ProviderInstance,
  RpcMethodName,
  RpcParams,
  RpcResult,
  ServerFrame,
  StoredEvent,
} from '@beddcode/contracts'

import { readHosts, writeHosts } from './storage'

/** Everything the app knows about one host: its connection, its sessions, its capabilities. */
export interface HostRuntime {
  connection: ConnectionState
  host: HostInfo | null
  providers: ProviderInstance[]
  projects: Project[]
  replica: ReplicaState
  /** Counts connections made so far; panes re-attach (terminals, watchers) when it changes. */
  epoch: number
  /** True once the first replay finished, so the UI can tell "empty" from "still loading". */
  synced: boolean
  /** Why the agents or projects could not be read; cleared once they are (it keeps retrying). */
  loadError?: string
}

const emptyRuntime = (): HostRuntime => ({
  connection: 'connecting',
  host: null,
  providers: [],
  projects: [],
  replica: emptyReplica(),
  epoch: 0,
  synced: false,
})

interface HostsState {
  /** False until the saved hosts were read; the screens wait for it so they do not flash "no hosts". */
  ready: boolean
  /** Paired hosts in the order they were added. A phone has no host of its own. */
  entries: HostEntry[]
  runtimes: Record<string, HostRuntime>
}

export const useHostStore = create<HostsState>(() => ({
  ready: false,
  entries: [],
  runtimes: {},
}))

const clients = new Map<string, HostClient>()

type LiveFrame = Extract<ServerFrame, { t: 'term.out' | 'term.exit' | 'fs.changed' }>
const frameListeners = new Map<string, Set<(frame: LiveFrame) => void>>()

/** Terminal output and file-change notifications of one host. Returns the function that unsubscribes. */
export function onHostFrame(hostKey: string, listener: (frame: LiveFrame) => void): () => void {
  const set = frameListeners.get(hostKey) ?? new Set()
  frameListeners.set(hostKey, set)
  set.add(listener)
  return () => set.delete(listener)
}

/** Sends a frame to a host; false when not connected (nothing was sent). */
export function sendHostFrame(hostKey: string, frame: ClientFrame): boolean {
  return clients.get(hostKey)?.send(frame) ?? false
}

function requireClient(hostKey: string): HostClient {
  const client = clients.get(hostKey)
  if (!client) throw new Error('That host is not connected')
  return client
}

/** Any host request, for features (git, files, terminals) that read live state instead of the event log. */
export function hostRequest<M extends RpcMethodName>(
  hostKey: string,
  method: M,
  params: RpcParams<M>,
): Promise<RpcResult<M>> {
  return requireClient(hostKey).request(method, params)
}

function patchRuntime(hostKey: string, patch: (r: HostRuntime) => Partial<HostRuntime>) {
  useHostStore.setState((s) => {
    const current = s.runtimes[hostKey] ?? emptyRuntime()
    return { runtimes: { ...s.runtimes, [hostKey]: { ...current, ...patch(current) } } }
  })
}

export async function refreshProjects(hostKey: string) {
  const projects = await hostRequest(hostKey, 'projects.list', {})
  patchRuntime(hostKey, () => ({ projects }))
}

/** Reads the host's agents and projects after connecting, retrying until both are in. */
function loadHostLists(hostKey: string, client: HostClient) {
  const epoch = useHostStore.getState().runtimes[hostKey]?.epoch
  const isCurrent = () =>
    clients.get(hostKey) === client &&
    client.connectionState === 'connected' &&
    useHostStore.getState().runtimes[hostKey]?.epoch === epoch
  const failed = (what: string) => (error: Error) =>
    patchRuntime(hostKey, () => ({ loadError: `Could not read the ${what}: ${error.message}` }))
  const providers = retryWhileCurrent(() => client.request('providers.list', {}), {
    isCurrent,
    onError: failed('agents on this host'),
  }).then((list) => {
    if (list && isCurrent()) patchRuntime(hostKey, () => ({ providers: list }))
    return list
  })
  const projects = retryWhileCurrent(() => client.request('projects.list', {}), {
    isCurrent,
    onError: failed('projects on this host'),
  }).then((list) => {
    if (list && isCurrent()) patchRuntime(hostKey, () => ({ projects: list }))
    return list
  })
  void Promise.all([providers, projects]).then(([a, b]) => {
    if (a && b && isCurrent()) patchRuntime(hostKey, () => ({ loadError: undefined }))
  })
}

function startHost(entry: HostEntry) {
  clients.get(entry.key)?.stop()
  patchRuntime(entry.key, () => emptyRuntime())

  const queue: StoredEvent[] = []
  let scheduled = false
  // Coalesce bursts of streamed events into one state update per frame.
  const flush = () => {
    scheduled = false
    const batch = queue.splice(0)
    // A queued animation frame may outlive removing or re-pairing this host.
    if (clients.get(entry.key) !== client) return
    if (batch.length)
      patchRuntime(entry.key, (r) => ({ replica: batch.reduce(applyEvent, r.replica) }))
  }

  const client = new HostClient({
    url: entry.routes,
    token: entry.token,
    expectedHostId: entry.key,
    onEvent(stored) {
      queue.push(stored)
      if (!scheduled) {
        scheduled = true
        requestAnimationFrame(flush)
      }
    },
    onFrame(frame) {
      frameListeners.get(entry.key)?.forEach((l) => l(frame))
    },
    onCaughtUp() {
      flush()
      patchRuntime(entry.key, () => ({ synced: true }))
    },
    onState(connection, host) {
      patchRuntime(entry.key, (r) => ({
        connection,
        host: host ?? r.host,
        epoch: connection === 'connected' ? r.epoch + 1 : r.epoch,
      }))
      if (connection === 'connected') loadHostLists(entry.key, client)
    },
  })
  clients.set(entry.key, client)
  client.start()
}

let started = false

/** Reads the saved hosts and connects to each. Safe to call twice. */
export async function startHosts() {
  if (started) return
  started = true
  // `loadRemoteHosts` reads through a synchronous storage; the phone's is asynchronous, so read first.
  const raw = await readHosts()
  const saved = loadRemoteHosts({ getItem: () => raw, setItem: () => {} })
  useHostStore.setState({ entries: saved, ready: true })
  saved.forEach(startHost)
  // Back in the foreground the phone may have changed networks or slept: check every connection
  // now instead of waiting out a heartbeat or a reconnect back-off.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') reconnectHostsNow()
  })
}

/** Checks every connection at once (after sleep or a network change). */
export function reconnectHostsNow() {
  for (const client of clients.values()) client.reconnectNow()
}

async function persist(entries: HostEntry[]) {
  let raw: string | null = null
  saveRemoteHosts({ getItem: () => null, setItem: (_k, value) => (raw = value) }, entries)
  if (raw !== null) await writeHosts(raw)
}

/** Remembers a host (replacing an earlier pairing of the same one) and connects to it. */
export function addRemoteHost(entry: HostEntry) {
  const entries = upsertHost(useHostStore.getState().entries, entry)
  useHostStore.setState({ entries })
  void persist(entries)
  startHost(entry)
}

export function removeRemoteHost(hostKey: string) {
  clients.get(hostKey)?.stop()
  clients.delete(hostKey)
  frameListeners.delete(hostKey)
  const entries = useHostStore.getState().entries.filter((e) => e.key !== hostKey)
  useHostStore.setState((s) => {
    const { [hostKey]: _gone, ...runtimes } = s.runtimes
    return { entries, runtimes }
  })
  void persist(entries)
}

/** The route currently in use for a host, e.g. to show where it is reached. */
export const activeRoute = (hostKey: string) => clients.get(hostKey)?.activeUrl

// -- reading ---------------------------------------------------------------

const EMPTY_RUNTIME = emptyRuntime()

export function useRuntime(hostKey: string | undefined): HostRuntime {
  return useHostStore((s) => (hostKey ? s.runtimes[hostKey] : undefined) ?? EMPTY_RUNTIME)
}

export interface HostedSession {
  hostKey: string
  session: SessionView
}

/** Sessions of every host, newest activity first within each host. */
export function useAllSessions(): HostedSession[] {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  return useMemo(
    () =>
      entries.flatMap((e) => {
        const replica = runtimes[e.key]?.replica
        return replica
          ? replica.order.map((id) => ({ hostKey: e.key, session: replica.sessions[id]! }))
          : []
      }),
    [entries, runtimes],
  )
}

/** Which host a session lives on (session ids are unique across hosts). */
export function hostKeyOfSession(sessionId: string): string | undefined {
  const { runtimes } = useHostStore.getState()
  return (
    Object.keys(runtimes).find((k) => runtimes[k]!.replica.sessions[sessionId]) ??
    createdOn.get(sessionId)
  )
}

export function useSessionHostKey(sessionId: string | undefined): string | undefined {
  return useHostStore((s) =>
    sessionId
      ? Object.keys(s.runtimes).find((k) => s.runtimes[k]!.replica.sessions[sessionId])
      : undefined,
  )
}

export function useSession(sessionId: string | undefined): SessionView | undefined {
  return useHostStore((s) => {
    if (!sessionId) return undefined
    for (const runtime of Object.values(s.runtimes)) {
      const found = runtime.replica.sessions[sessionId]
      if (found) return found
    }
    return undefined
  })
}

/** Providers that can start a session right now, in the order the host reports them. */
export function readyProviders(providers: ProviderInstance[]): ProviderInstance[] {
  return providers.filter((p) => p.status === 'ready')
}

// -- acting ----------------------------------------------------------------

/** Sessions just created here, until their first event arrives and the replica knows them. */
const createdOn = new Map<string, string>()

export async function createSession(
  hostKey: string,
  options: RpcParams<'sessions.create'>,
): Promise<string> {
  const { sessionId } = await hostRequest(hostKey, 'sessions.create', options)
  createdOn.set(sessionId, hostKey)
  return sessionId
}

/** Requests on a session go to the host that owns it. */
function sessionRequest<M extends RpcMethodName>(
  sessionId: string,
  method: M,
  params: RpcParams<M>,
): Promise<RpcResult<M>> {
  const hostKey = hostKeyOfSession(sessionId)
  if (!hostKey) return Promise.reject(new Error('That session is not available right now'))
  return hostRequest(hostKey, method, params)
}

/** Sends a message; while the agent is busy the host steers it in or queues it. */
export async function prompt(
  sessionId: string,
  text: string,
  attachmentIds?: string[],
  mode?: 'auto' | 'queue',
) {
  return sessionRequest(sessionId, 'sessions.prompt', {
    sessionId,
    text,
    attachments: attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
    mode,
  })
}

/** Cancels a queued message, or sends it into the running turn right away. */
export async function dequeue(sessionId: string, queueId: string, action: 'cancel' | 'steer') {
  await sessionRequest(sessionId, 'sessions.dequeue', { sessionId, queueId, action })
}

/** Answers a question the agent asked; no `answers` dismisses it. */
export async function answerQuestion(
  sessionId: string,
  requestId: string,
  answers?: Record<string, string[]>,
) {
  await sessionRequest(sessionId, 'sessions.answer', { sessionId, requestId, answers })
}

/** Switches a session's model and reasoning effort from its next message on. */
export async function setSessionModel(
  sessionId: string,
  model: string | undefined,
  effort: string | undefined,
) {
  await sessionRequest(sessionId, 'sessions.setModel', { sessionId, model, effort })
}

export async function interrupt(sessionId: string) {
  await sessionRequest(sessionId, 'sessions.interrupt', { sessionId })
}

/** Moves a session into the Done section, or back out of it. */
export async function setSessionDone(sessionId: string, done: boolean) {
  await sessionRequest(sessionId, 'sessions.setDone', { sessionId, done })
}

export async function setMode(sessionId: string, modeId: string) {
  await sessionRequest(sessionId, 'sessions.setMode', { sessionId, modeId })
}

export async function approve(sessionId: string, requestId: string, optionId: string) {
  await sessionRequest(sessionId, 'sessions.approve', { sessionId, requestId, optionId })
}

/** The HTTP address of a host (where media and downloads are served), from the route in use. */
export function hostHttpBase(hostKey: string): string | undefined {
  const route =
    activeRoute(hostKey) ??
    useHostStore.getState().entries.find((e) => e.key === hostKey)?.routes[0]
  return route?.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '')
}
