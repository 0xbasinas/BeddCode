import { readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SlashCommand } from '@beddcode/contracts'

/** First meaningful line of a markdown file's front matter `description:` or its first paragraph. */
export function describe(markdown: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  const fromFront = front && /^description:\s*(.+)$/im.exec(front[1]!)?.[1]
  if (fromFront) return fromFront.trim().replace(/^["']|["']$/g, '')
  const body = front ? markdown.slice(front[0].length) : markdown
  const line = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return line?.slice(0, 140)
}

/** The `argument-hint:` front-matter field, which Claude shows after the command name. */
export function argumentHint(markdown: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  const hint = front && /^argument-hint:\s*(.+)$/im.exec(front[1]!)?.[1]
  return hint ? hint.trim().replace(/^["']|["']$/g, '') : undefined
}

/**
 * Claude Code's built-in commands that make sense without its terminal UI. Shown before a session
 * starts; a running session replaces the list with the one Claude reports.
 */
export const CLAUDE_BUILTINS: SlashCommand[] = [
  { name: 'compact', hint: '[instructions]', description: 'Summarize the conversation to free up context', kind: 'command' },
  { name: 'init', description: 'Write a CLAUDE.md that describes this codebase', kind: 'command' },
  { name: 'review', description: 'Review a pull request', kind: 'command' },
  { name: 'security-review', description: 'Review the pending changes for security issues', kind: 'command' },
]

function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Custom commands (`.claude/commands/*.md`) and skills (`.claude/skills/<name>/SKILL.md`) from the
 * user's and the project's Claude folders. Read from disk so nothing has to be started; a running
 * session reports its own, complete list.
 */
export function scanClaudeCommands(cwd: string | undefined, home = os.homedir()): SlashCommand[] {
  const roots = [path.join(home, '.claude'), ...(cwd ? [path.join(cwd, '.claude')] : [])]
  const found = new Map<string, SlashCommand>()

  for (const root of roots) {
    const commands = path.join(root, 'commands')
    for (const file of entries(commands)) {
      if (!file.endsWith('.md')) continue
      const name = file.slice(0, -3)
      const text = read(path.join(commands, file))
      found.set(name, {
        name,
        description: describe(text),
        ...(argumentHint(text) ? { hint: argumentHint(text) } : {}),
        kind: 'command',
      })
    }
    const skills = path.join(root, 'skills')
    for (const dir of entries(skills)) {
      if (!isDir(path.join(skills, dir))) continue
      const text = read(path.join(skills, dir, 'SKILL.md'))
      if (!text) continue
      found.set(dir, {
        name: dir,
        description: describe(text),
        ...(argumentHint(text) ? { hint: argumentHint(text) } : {}),
        kind: 'skill',
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}
