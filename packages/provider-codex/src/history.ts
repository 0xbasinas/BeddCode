import type { SessionEvent, SlashCommand } from '@beddcode/contracts'
import type { HistoryItem, HistoryTurn } from '@beddcode/provider-core'
import { JsonRpcClient, type Logger, type Transport } from '@beddcode/shared'
import { CodexEventMapper } from './mapper.ts'

type Obj = Record<string, unknown>

/** Runs one short conversation with a throwaway `codex app-server`; nothing is left running. */
export type WithAppServer = <T>(fn: (rpc: JsonRpcClient) => Promise<T>, cwd?: string) => Promise<T>

export function createWithAppServer(
  makeTransport: (cwd: string) => Transport,
  log: Logger,
  timeoutMs = 20_000,
): WithAppServer {
  return async (fn, cwd = process.cwd()) => {
    const rpc = new JsonRpcClient(makeTransport(cwd), log)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          await rpc.request('initialize', {
            clientInfo: { name: 'beddcode', title: 'BeddCode', version: '0.0.0' },
            capabilities: null,
          })
          rpc.notify('initialized')
          return fn(rpc)
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Codex did not answer in time')), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
      rpc.close()
    }
  }
}

interface CodexThread {
  id: string
  name?: string | null
  preview?: string
  updatedAt?: number
  cwd?: string
  turns?: { id: string; items?: Obj[] }[]
}

/** Codex's own item list of a turn, reduced to what was said. */
export function turnText(turn: { items?: Obj[] }): HistoryTurn {
  let user = ''
  let assistant = ''
  for (const item of turn.items ?? []) {
    if (item.type === 'userMessage' && Array.isArray(item.content)) {
      const text = (item.content as Obj[])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n')
      user = user ? `${user}\n${text}` : text
    } else if (item.type === 'agentMessage' && typeof item.text === 'string') {
      assistant = assistant ? `${assistant}\n\n${item.text}` : item.text
    }
  }
  return { user, assistant }
}

/** Everything the agent did in a stored turn, through the mapper that handles it live. */
export function turnEvents(turn: { items?: Obj[] }, cwd: string): SessionEvent[] {
  const mapper = new CodexEventMapper('history', cwd)
  const kept = new Set<SessionEvent['type']>([
    'message.delta',
    'tool.started',
    'tool.completed',
    'diff',
  ])
  const events: SessionEvent[] = []
  for (const item of turn.items ?? []) {
    if (item.type === 'userMessage') continue
    for (const method of ['item/started', 'item/completed']) {
      for (const event of mapper.map(method, { item })) if (kept.has(event.type)) events.push(event)
    }
  }
  return events
}

export function createCodexHistory(run: WithAppServer) {
  const readTurns = async (threadId: string, cwd?: string) =>
    run(async (rpc) => {
      const res = await rpc.request<{ thread: CodexThread }>('thread/read', {
        threadId,
        includeTurns: true,
      })
      return res.thread.turns ?? []
    }, cwd)

  return {
    async list(cwd?: string): Promise<HistoryItem[]> {
      return run(async (rpc) => {
        const res = await rpc.request<{ data: CodexThread[] }>('thread/list', {
          limit: 50,
          ...(cwd ? { cwd } : {}),
        })
        return res.data
          .map((t) => ({
            id: t.id,
            title: (t.name || t.preview || 'Untitled').trim().replace(/\s+/g, ' ').slice(0, 120),
            // Codex stores seconds.
            updatedAt: t.updatedAt ? t.updatedAt * 1000 : undefined,
            cwd: t.cwd,
          }))
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      }, cwd)
    },

    async read(threadId: string, cwd?: string): Promise<HistoryTurn[]> {
      return (await readTurns(threadId, cwd))
        .map((turn) => ({ ...turnText(turn), events: turnEvents(turn, cwd ?? '') }))
        .filter((t) => t.user || t.assistant || t.events.length > 0)
    },

    async fork(threadId: string, cwd: string, throughTurn?: number): Promise<string> {
      let lastTurnId: string | undefined
      if (throughTurn !== undefined) {
        const turns = await readTurns(threadId, cwd)
        if (throughTurn > turns.length)
          throw new Error(`The conversation has only ${turns.length} turns`)
        // Ending at the last turn is the same as forking everything.
        if (throughTurn < turns.length) lastTurnId = turns[throughTurn - 1]?.id
      }
      return run(async (rpc) => {
        const res = await rpc.request<{ thread: CodexThread }>('thread/fork', {
          threadId,
          cwd,
          ...(lastTurnId ? { lastTurnId } : {}),
        })
        return res.thread.id
      }, cwd)
    },
  }
}

/** Skills available in a folder, as Codex lists them. */
export async function listCodexSkills(run: WithAppServer, cwd: string): Promise<SlashCommand[]> {
  return run(async (rpc) => {
    const res = await rpc.request<{ data: { skills: Obj[] }[] }>('skills/list', { cwds: [cwd] })
    return skillsToCommands(res.data.flatMap((entry) => entry.skills))
  }, cwd)
}

export function skillsToCommands(skills: Obj[]): SlashCommand[] {
  return skills
    .filter((s) => s.enabled !== false && typeof s.name === 'string')
    .map((s) => ({
      name: s.name as string,
      description:
        (typeof s.shortDescription === 'string' && s.shortDescription) ||
        (typeof s.description === 'string' ? s.description : undefined),
      kind: 'skill' as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
