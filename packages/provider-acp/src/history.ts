import type { HistoryItem, HistoryTurn } from '@beddcode/provider-core'
import { JsonRpcClient, type Logger, type Transport } from '@beddcode/shared'

type Obj = Record<string, unknown>

interface Capabilities {
  loadSession?: boolean
  sessionCapabilities?: { list?: unknown; resume?: unknown; close?: unknown }
}

const INIT_TIMEOUT = 30_000
const LOAD_TIMEOUT = 60_000

/**
 * One short conversation with a throwaway agent process, for listing and reading history. The
 * process is always closed afterwards.
 */
export async function withAcpAgent<T>(
  transport: Transport,
  log: Logger,
  label: string,
  fn: (rpc: JsonRpcClient, caps: Capabilities) => Promise<T>,
): Promise<T> {
  const rpc = new JsonRpcClient(transport, log, { jsonrpc2: true })
  try {
    const init = await rpc.request<{ protocolVersion?: number; agentCapabilities?: Capabilities }>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: 'beddcode', title: 'BeddCode', version: '0.0.0' },
      },
      { timeoutMs: INIT_TIMEOUT },
    )
    if (init.protocolVersion !== 1) {
      throw new Error(
        `${label} speaks ACP v${String(init.protocolVersion)}, which is not supported yet`,
      )
    }
    return await fn(rpc, init.agentCapabilities ?? {})
  } catch (err) {
    const tail = rpc.stderrTail.split('\n').filter(Boolean).at(-1)
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(tail && /ended|closed/.test(message) ? `${label}: ${tail}` : message)
  } finally {
    rpc.close()
  }
}

/** The agent's own list of stored sessions for a folder, newest first. */
export async function listAcpSessions(
  rpc: JsonRpcClient,
  caps: Capabilities,
  label: string,
  cwd?: string,
): Promise<HistoryItem[]> {
  if (!caps.sessionCapabilities?.list)
    throw new Error(`${label} does not list its earlier sessions`)
  const items: HistoryItem[] = []
  let cursor: string | undefined
  // A few pages are plenty for a picker; a misbehaving agent cannot make this loop forever.
  for (let page = 0; page < 5; page++) {
    const res = await rpc.request<{ sessions?: Obj[]; nextCursor?: string | null }>(
      'session/list',
      { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) },
      { timeoutMs: LOAD_TIMEOUT },
    )
    for (const s of res.sessions ?? []) {
      const updated = typeof s.updatedAt === 'string' ? Date.parse(s.updatedAt) : NaN
      items.push({
        id: String(s.sessionId),
        title: (typeof s.title === 'string' && s.title.trim() ? s.title.trim() : 'Untitled').slice(
          0,
          120,
        ),
        updatedAt: Number.isNaN(updated) ? undefined : updated,
        cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
      })
    }
    cursor = res.nextCursor ?? undefined
    if (!cursor) break
  }
  return items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/**
 * Loading a session makes the agent replay it as updates. Messages alternate between the user and
 * the agent; each time the user speaks after the agent did, a new exchange starts.
 */
export function groupReplay(updates: Obj[]): HistoryTurn[] {
  const turns: HistoryTurn[] = []
  let lastRole: 'user' | 'assistant' | null = null
  for (const update of updates) {
    const kind = update.sessionUpdate
    if (kind !== 'user_message_chunk' && kind !== 'agent_message_chunk') continue
    const content = update.content as Obj | undefined
    const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
    if (!text) continue
    if (kind === 'user_message_chunk') {
      if (lastRole !== 'user') turns.push({ user: '', assistant: '' })
      turns.at(-1)!.user += text
      lastRole = 'user'
    } else {
      if (turns.length === 0) turns.push({ user: '', assistant: '' })
      turns.at(-1)!.assistant += text
      lastRole = 'assistant'
    }
  }
  return turns
}

/** Reads one session by loading it and collecting what the agent replays. */
export async function readAcpSession(
  rpc: JsonRpcClient,
  caps: Capabilities,
  label: string,
  sessionId: string,
  cwd: string,
): Promise<HistoryTurn[]> {
  if (!caps.loadSession) throw new Error(`${label} cannot replay its earlier sessions`)
  const updates: Obj[] = []
  rpc.onNotification((method, params) => {
    const p = (params ?? {}) as Obj
    if (method === 'session/update' && p.sessionId === sessionId && p.update) {
      updates.push(p.update as Obj)
    }
  })
  await rpc.request('session/load', { sessionId, cwd, mcpServers: [] }, { timeoutMs: LOAD_TIMEOUT })
  return groupReplay(updates)
}
