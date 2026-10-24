import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SlashCommand } from '@beddcode/contracts'

/** Codex's own commands that work outside its terminal UI, through the app-server. */
export const CODEX_BUILTINS: SlashCommand[] = [
  {
    name: 'compact',
    description: 'Summarize the conversation so far to free up context',
    kind: 'command',
  },
  {
    name: 'review',
    hint: '[what to focus on]',
    description: 'Review the uncommitted changes, or follow your instructions',
    kind: 'command',
  },
]

/** Where Codex keeps custom prompts: `$CODEX_HOME/prompts`, else `~/.codex/prompts`. */
export function codexPromptsDir(env = process.env, home = os.homedir()): string {
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'prompts')
}

function frontMatter(markdown: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!match) return { fields: {}, body: markdown }
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '')
  }
  return { fields, body: markdown.slice(match[0].length) }
}

/** Custom prompts (`<name>.md`), offered the way Codex names them: `/prompts:<name>`. */
export function scanCodexPrompts(dir = codexPromptsDir()): SlashCommand[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      let text = ''
      try {
        text = readFileSync(path.join(dir, file), 'utf8')
      } catch {
        // unreadable: still listed, without a description
      }
      const { fields, body } = frontMatter(text)
      const firstLine = body
        .split(/\r?\n/)
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .find(Boolean)
      return {
        name: `prompts:${file.slice(0, -3)}`,
        description: fields.description || firstLine?.slice(0, 140),
        hint: fields['argument-hint'] || undefined,
        kind: 'command' as const,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Splits arguments like a shell would for prompt placeholders: spaces, with quotes kept together. */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}

/**
 * Fills a custom prompt the way Codex does: `$1`…`$9` are positional arguments, `$ARGUMENTS` is all
 * of them, `$NAME` comes from `NAME=value` arguments, and `$$` is a literal dollar sign.
 */
export function expandPrompt(markdown: string, args: string): string {
  const { body } = frontMatter(markdown)
  const parts = splitArgs(args)
  const named = new Map<string, string>()
  const positional: string[] = []
  for (const part of parts) {
    const kv = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/.exec(part)
    if (kv) named.set(kv[1]!, kv[2]!)
    else positional.push(part)
  }
  const usesPlaceholders = /\$(?:ARGUMENTS|[1-9]|[A-Z][A-Z0-9_]*)/.test(body)
  const filled = body.replace(/\$\$|\$ARGUMENTS|\$([1-9])|\$([A-Z][A-Z0-9_]*)/g, (all, n, name) => {
    if (all === '$$') return '$'
    if (all === '$ARGUMENTS') return positional.join(' ')
    if (n) return positional[Number(n) - 1] ?? ''
    return named.get(name as string) ?? all
  })
  // A prompt without placeholders still gets what was typed after it.
  return (
    usesPlaceholders || !args.trim() ? filled : `${filled.trimEnd()}\n\n${args.trim()}`
  ).trim()
}

/** `/name rest` → its parts, or null when the text is not a command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1]!, args: m[2]?.trim() ?? '' } : null
}

/** The prompt file behind `/prompts:<name>`, or null when there is none. */
export function readCodexPrompt(name: string, dir = codexPromptsDir()): string | null {
  if (!name.startsWith('prompts:')) return null
  const file = name.slice('prompts:'.length)
  if (!/^[\w.-]+$/.test(file)) return null
  try {
    return readFileSync(path.join(dir, `${file}.md`), 'utf8')
  } catch {
    return null
  }
}
