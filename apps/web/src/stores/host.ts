import { create } from 'zustand'
import {
  HostClient,
  applyEvent,
  emptyReplica,
  type ConnectionState,
  type ReplicaState,
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

const HOST_URL = import.meta.env.VITE_BEDDCODE_HOST_WS ?? 'ws://127.0.0.1:3773/ws'

export interface UploadedFile {
  id: string
  name: string
  size: number
}

interface HostState {
  connection: ConnectionState
  host: HostInfo | null
  providers: ProviderInstance[]
  projects: Project[]
  replica: ReplicaState
  /** Counts connections made so far; panes re-attach (terminals, watchers) when it changes. */
  epoch: number
  /** True once the first replay finished, so the UI can tell "empty" from "still loading". */
  synced: boolean
  addProject(path: string): Promise<Project>
  removeProject(path: string): Promise<void>
  createSession(options: RpcParams<'sessions.create'>): Promise<string>
  upload(file: File): Promise<UploadedFile>
  prompt(sessionId: string, text: string, attachmentIds?: string[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  setMode(sessionId: string, modeId: string): Promise<void>
  approve(sessionId: string, requestId: string, optionId: string): Promise<void>
}

let client: HostClient | null = null

type LiveFrame = Extract<ServerFrame, { t: 'term.out' | 'term.exit' | 'fs.changed' }>
const frameListeners = new Set<(frame: LiveFrame) => void>()

/** Terminal output and file-change notifications. Returns the function that unsubscribes. */
export function onHostFrame(listener: (frame: LiveFrame) => void): () => void {
  frameListeners.add(listener)
  return () => frameListeners.delete(listener)
}

/** Sends a frame to the host; false when not connected (nothing was sent). */
export function sendHostFrame(frame: ClientFrame): boolean {
  return client?.send(frame) ?? false
}

export const useHostStore = create<HostState>(() => ({
  connection: 'connecting',
  host: null,
  providers: [],
  projects: [],
  replica: emptyReplica(),
  epoch: 0,
  synced: false,

  async addProject(path) {
    const project = await requireClient().request('projects.add', { path })
    await refreshProjects()
    return project
  },
  async removeProject(path) {
    await requireClient().request('projects.remove', { path })
    await refreshProjects()
  },
  async createSession(options) {
    const { sessionId } = await requireClient().request('sessions.create', options)
    return sessionId
  },
  async upload(file) {
    return requireClient().request('attachments.upload', {
      name: file.name,
      dataBase64: await toBase64(file),
    })
  },
  async prompt(sessionId, text, attachmentIds) {
    await requireClient().request('sessions.prompt', {
      sessionId,
      text,
      attachments: attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
    })
  },
  async interrupt(sessionId) {
    await requireClient().request('sessions.interrupt', { sessionId })
  },
  async setMode(sessionId, modeId) {
    await requireClient().request('sessions.setMode', { sessionId, modeId })
  },
  async approve(sessionId, requestId, optionId) {
    await requireClient().request('sessions.approve', { sessionId, requestId, optionId })
  },
}))

/** Any host request, for features (git, PRs) that read live state instead of the event log. */
export function hostRequest<M extends RpcMethodName>(
  method: M,
  params: RpcParams<M>,
): Promise<RpcResult<M>> {
  return requireClient().request(method, params)
}

export async function refreshProjects() {
  const projects = await requireClient().request('projects.list', {})
  useHostStore.setState({ projects })
}

function requireClient(): HostClient {
  if (!client) throw new Error('Host client not started')
  return client
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

/** Providers that can start a session right now, in the order the host reports them. */
export function readyProviders(providers: ProviderInstance[]): ProviderInstance[] {
  return providers.filter((p) => p.status === 'ready')
}

/** Starts the single host connection. Safe to call twice (React StrictMode). */
export function connectToLocalHost() {
  if (client) return
  const queue: StoredEvent[] = []
  let scheduled = false

  // Coalesce bursts of streamed events into one state update per frame.
  const flush = () => {
    scheduled = false
    const batch = queue.splice(0)
    useHostStore.setState((s) => ({ replica: batch.reduce(applyEvent, s.replica) }))
  }

  client = new HostClient({
    url: HOST_URL,
    onEvent(stored) {
      queue.push(stored)
      if (!scheduled) {
        scheduled = true
        requestAnimationFrame(flush)
      }
    },
    onFrame(frame) {
      frameListeners.forEach((l) => l(frame))
    },
    onCaughtUp() {
      flush()
      useHostStore.setState({ synced: true })
    },
    onState(connection, host) {
      useHostStore.setState((s) => ({
        connection,
        host: host ?? s.host,
        epoch: connection === 'connected' ? s.epoch + 1 : s.epoch,
      }))
      if (connection === 'connected') {
        client
          ?.request('providers.list', {})
          .then((providers) => useHostStore.setState({ providers }))
          .catch(() => {})
        refreshProjects().catch(() => {})
      }
    },
  })
  client.start()
}
