import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'

/** Where Claude Code keeps its per-folder conversation files. */
export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
}

/** The conversation's file, found by id under whichever folder it was started in. */
export function findTranscript(sessionId: string, root = claudeProjectsDir()): string | undefined {
  if (!/^[\w-]+$/.test(sessionId) || !existsSync(root)) return undefined
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const file = join(root, dir.name, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return undefined
}

/** A tool result is only ever shown shortened; no need to hold all of a huge one. */
const KEEP = 8_000

function shorten(message: unknown): unknown {
  const content = (message as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return message
  return {
    ...(message as object),
    content: content.map((b) =>
      b && b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > KEEP
        ? { ...b, content: b.content.slice(0, KEEP) }
        : b,
    ),
  }
}

/**
 * Every message of a conversation in the order it was written. The SDK follows the chain from the
 * latest message back and stops at a compaction, so a conversation that was compacted loses
 * everything before it; the file still has all of it. Compaction summaries, side chains (subagents)
 * and the CLI's own bookkeeping are left out.
 */
export async function readTranscript(file: string): Promise<SessionMessage[]> {
  const out: SessionMessage[] = []
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) })
  for await (const line of lines) {
    if (!line.startsWith('{')) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    if (entry.isSidechain === true || entry.isCompactSummary === true || entry.isMeta === true)
      continue
    if (typeof entry.uuid !== 'string' || !entry.message) continue
    out.push({
      type: entry.type,
      uuid: entry.uuid,
      session_id: String(entry.sessionId ?? ''),
      message: shorten(entry.message),
      parent_tool_use_id: null,
      parent_agent_id: null,
    } as SessionMessage)
  }
  return out
}
