import type {
  ForkSessionOptions,
  ForkSessionResult,
  ListSessionsOptions,
  SDKSessionInfo,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@beddcode/contracts'
import type { HistoryItem, HistoryTurn } from '@beddcode/provider-core'
import { ClaudeEventMapper } from './mapper.ts'
import { findTranscript, readTranscript } from './transcriptFile.ts'

/** The parts of the SDK that read Claude's own stored conversations; injected in tests. */
export interface ClaudeHistorySdk {
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>
  getSessionMessages(sessionId: string, options?: { dir?: string }): Promise<SessionMessage[]>
  forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult>
}

interface Block {
  type?: string
  text?: unknown
}

function content(message: unknown): unknown {
  return typeof message === 'object' && message !== null
    ? (message as { content?: unknown }).content
    : undefined
}

/** Text a person typed: a string, or text blocks. Tool results and system injections do not count. */
function typedText(message: unknown): string {
  const c = content(message)
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return (c as Block[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** What the agent said in words, not the tools it used. */
function spokenText(message: unknown): string {
  return typedText(message)
}

/** Slash-command echoes and hook output are stored as user text; they are not the user's request. */
function isInjected(text: string): boolean {
  return /^<(command-name|command-message|local-command|system-reminder|user-prompt-submit-hook)/.test(
    text.trimStart(),
  )
}

/** The events of a stored exchange worth showing again; usage and turn bookkeeping are not. */
const KEPT = new Set<SessionEvent['type']>([
  'message.delta',
  'tool.started',
  'tool.completed',
  'diff',
  'plan.updated',
])

export interface GroupedTurn extends HistoryTurn {
  /** The last stored message of this turn, which a fork can end at. */
  lastUuid: string
}

/** Splits a transcript into exchanges: each starts with something the user typed. */
export function groupTurns(messages: SessionMessage[], cwd?: string): GroupedTurn[] {
  const turns: GroupedTurn[] = []
  // The live mapper turns stored messages into the same message, tool and edit events.
  let at = Date.now()
  const mapper = new ClaudeEventMapper('history', { cwd, now: () => at })
  for (const m of messages) {
    // Subagents and system rows are not part of the visible conversation.
    if (m.parent_tool_use_id !== null || m.parent_agent_id) continue
    if (m.type === 'user') {
      const text = typedText(m.message)
      if (isInjected(text)) continue
      if (text.trim()) {
        turns.push({ user: text, assistant: '', events: [], lastUuid: m.uuid })
        continue
      }
    }
    const current = turns.at(-1)
    if (!current) continue
    current.lastUuid = m.uuid
    const written = (m as { timestamp?: unknown }).timestamp
    if (typeof written === 'number' && Number.isFinite(written)) at = written
    if (m.type === 'assistant' || m.type === 'user') {
      for (const event of mapper.map(m as unknown as SDKMessage)) {
        if (KEPT.has(event.type)) current.events!.push(event)
      }
    }
    if (m.type === 'assistant') {
      const said = spokenText(m.message)
      if (said) current.assistant = current.assistant ? `${current.assistant}\n\n${said}` : said
    }
  }
  return turns
}

/** Reads a whole conversation from its file, or nothing when it cannot be found or read. */
export type ReadWhole = (sessionId: string) => Promise<SessionMessage[] | undefined>

const readWholeFromDisk: ReadWhole = async (sessionId) => {
  try {
    const file = findTranscript(sessionId)
    return file ? await readTranscript(file) : undefined
  } catch {
    return undefined
  }
}

export function createClaudeHistory(
  sdk: ClaudeHistorySdk,
  readWhole: ReadWhole = readWholeFromDisk,
) {
  return {
    async list(cwd?: string): Promise<HistoryItem[]> {
      const sessions = await sdk.listSessions({ dir: cwd, limit: 50 })
      return sessions
        .map((s) => ({
          id: s.sessionId,
          title: (s.customTitle || s.summary || s.firstPrompt || 'Untitled').trim().slice(0, 120),
          updatedAt: s.lastModified,
          cwd: s.cwd,
        }))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    },

    async read(sessionId: string, cwd?: string): Promise<HistoryTurn[]> {
      // The file holds what came before a compaction; the SDK's view starts at the last one.
      const messages =
        (await readWhole(sessionId)) ?? (await sdk.getSessionMessages(sessionId, { dir: cwd }))
      return groupTurns(messages, cwd).map(({ user, assistant, events }) => ({
        user,
        assistant,
        events,
      }))
    },

    async fork(sessionId: string, cwd: string, throughTurn?: number): Promise<string> {
      let upToMessageId: string | undefined
      if (throughTurn !== undefined) {
        const turns = groupTurns(await sdk.getSessionMessages(sessionId, { dir: cwd }))
        if (throughTurn > turns.length)
          throw new Error(`The conversation has only ${turns.length} turns`)
        // Ending at the last turn is the same as copying everything.
        if (throughTurn < turns.length) upToMessageId = turns[throughTurn - 1]?.lastUuid
      }
      const forked = await sdk.forkSession(sessionId, { dir: cwd, upToMessageId })
      return forked.sessionId
    },
  }
}
