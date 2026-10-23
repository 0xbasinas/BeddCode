import { useMemo } from 'react'
import { create } from 'zustand'
import {
  HostClient,
  applyEvent,
  emptyReplica,
  type ConnectionState,
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
import {
  LOCAL_HOST_KEY,
  loadRemoteHosts,
  saveRemoteHosts,
  upsertHost,
  type HostEntry,
} from './hostCatalog.ts'
import { localHostUrl } from './localHostUrl.ts'

const LOCAL_URL = localHostUrl({
  override: import.meta.env.VITE_BEDDCODE_HOST_WS,
  dev: import.meta.env.DEV,
  location: typeof window === 'undefined' ? undefined : window.location,
})

export interface UploadedFile {
  id: string
  name: string
  size: number
}

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
  /** The local host first, then paired remote hosts in the order they were added. */
  entries: HostEntry[]
  runtimes: Record<string, HostRuntime>
}

const localEntry: HostEntry = { key: LOCAL_HOST_KEY, name: 'This computer', routes: [LOCAL_URL] }

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export const useHostStore = create<HostsState>(() => ({
  entries: [localEntry, ...loadRemoteHosts(storage())],
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

/** Re-detect installed CLIs after setup or a change to the ACP agent catalog. */
export async function refreshProviders(hostKey: string) {
  const client = requireClient(hostKey)
  const providers = await client.request('providers.list', {})
  if (clients.get(hostKey) === client) patchRuntime(hostKey, () => ({ providers }))
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
    expectedHostId: entry.key === LOCAL_HOST_KEY ? undefined : entry.key,
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
      if (connection === 'connected') {
        client
          .request('providers.list', {})
          .then((providers) => patchRuntime(entry.key, () => ({ providers })))
          .catch(() => {})
        refreshProjects(entry.key).catch(() => {})
      }
    },
  })
  clients.set(entry.key, client)
  client.start()
}

let started = false

/** Connects to this computer's host and every paired remote host. Safe to call twice (React StrictMode). */
export function startHosts() {
  if (started) return
  started = true
  useHostStore.getState().entries.forEach(startHost)
}

/** Remembers a remote host (replacing an earlier pairing of the same one) and connects to it. */
export function addRemoteHost(entry: HostEntry) {
  const entries = upsertHost(useHostStore.getState().entries, entry)
  useHostStore.setState({ entries })
  saveRemoteHosts(storage(), entries)
  startHost(entry)
}

export function removeRemoteHost(hostKey: string) {
  if (hostKey === LOCAL_HOST_KEY) return
  clients.get(hostKey)?.stop()
  clients.delete(hostKey)
  frameListeners.delete(hostKey)
  const entries = useHostStore.getState().entries.filter((e) => e.key !== hostKey)
  useHostStore.setState((s) => {
    const { [hostKey]: _gone, ...runtimes } = s.runtimes
    return { entries, runtimes }
  })
  saveRemoteHosts(storage(), entries)
}

/** The route currently in use for a host, e.g. to show where it is reached. */
export const activeRoute = (hostKey: string) => clients.get(hostKey)?.activeUrl

// -- reading ---------------------------------------------------------------

const EMPTY_RUNTIME = emptyRuntime()

export function useRuntime(hostKey: string): HostRuntime {
  return useHostStore((s) => s.runtimes[hostKey] ?? EMPTY_RUNTIME)
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

export async function addProject(hostKey: string, path: string): Promise<Project> {
  const project = await hostRequest(hostKey, 'projects.add', { path })
  await refreshProjects(hostKey)
  return project
}

export async function removeProject(hostKey: string, path: string): Promise<void> {
  await hostRequest(hostKey, 'projects.remove', { path })
  await refreshProjects(hostKey)
}

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

export async function upload(hostKey: string, file: File): Promise<UploadedFile> {
  return hostRequest(hostKey, 'attachments.upload', {
    name: file.name,
    dataBase64: await toBase64(file),
  })
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

export async function setConfigOption(
  sessionId: string,
  optionId: string,
  value: string | boolean,
) {
  await sessionRequest(sessionId, 'sessions.setConfig', { sessionId, optionId, value })
}

/** Starts a session that continues this one, keeping its first `throughTurn` turns (all if omitted). */
export async function forkSession(sessionId: string, throughTurn?: number): Promise<string> {
  const { sessionId: forked } = await sessionRequest(sessionId, 'sessions.fork', {
    sessionId,
    throughTurn,
  })
  createdOn.set(forked, hostKeyOfSession(sessionId) ?? LOCAL_HOST_KEY)
  return forked
}

export async function importSession(
  hostKey: string,
  params: RpcParams<'sessions.import'>,
): Promise<string> {
  const { sessionId } = await hostRequest(hostKey, 'sessions.import', params)
  createdOn.set(sessionId, hostKey)
  return sessionId
}

export async function interrupt(sessionId: string) {
  await sessionRequest(sessionId, 'sessions.interrupt', { sessionId })
}

/** Moves a session into the sidebar's Done section, or back out of it. */
export async function setSessionDone(sessionId: string, done: boolean) {
  await sessionRequest(sessionId, 'sessions.setDone', { sessionId, done })
}

export async function setMode(sessionId: string, modeId: string) {
  await sessionRequest(sessionId, 'sessions.setMode', { sessionId, modeId })
}

export async function approve(sessionId: string, requestId: string, optionId: string) {
  await sessionRequest(sessionId, 'sessions.approve', { sessionId, requestId, optionId })
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  // Chunked so large files do not overflow the argument limit of fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
