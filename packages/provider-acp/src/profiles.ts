import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ApprovalMode } from './permissions.ts'

/**
 * What is known about one specific ACP agent beyond what the protocol says. Some agents keep their
 * approval setting to themselves: no `modes`, no mode option. Where the agent's own documentation
 * says how to read and change it, a profile does so; every other agent gets the generic choices.
 */
export interface AgentProfile {
  /** The agent's real choices; `command` is the slash command that switches the session to it. */
  modes: (ApprovalMode & { command: string })[]
  /** The mode the agent will start in according to its own configuration, if it can be read. */
  current(): string | undefined
  /**
   * The arguments to start the agent with so it begins in `modeId` whatever its own configuration
   * says (a launch flag beats the config file), when it takes such flags.
   */
  launchArgs?(args: string[], modeId: string | undefined): string[]
}

/** Grok: `/always-approve on|off` switches a running session; `~/.grok/config.toml` sets the default. */
export function grokProfile(read: () => string | undefined = readGrokConfig): AgentProfile {
  return {
    modes: [
      {
        id: 'ask',
        label: 'Ask before tools',
        description: 'Read-only tools run; edits and other commands ask first.',
        command: '/always-approve off',
      },
      {
        id: 'approve-all',
        label: 'Always approve',
        description: 'Grok runs every tool without asking. Deny rules and hooks still apply.',
        dangerous: true,
        command: '/always-approve on',
      },
    ],
    current: () => grokMode(read()),
    launchArgs: grokLaunchArgs,
  }
}

/**
 * `grok --permission-mode <default|bypassPermissions> agent --no-leader stdio`. The mode is a
 * top-level flag and beats the user's config file; `bypassPermissions` is always-approve (checked
 * with Grok 1.0: `--always-approve` before `agent` does nothing for `agent stdio`, and after it
 * loses to `--permission-mode default`). `--no-leader` gives the session its own process instead
 * of joining a shared one that may carry another setup.
 */
export function grokLaunchArgs(args: string[], modeId: string | undefined): string[] {
  if (args[0] !== 'agent') return args
  const mode =
    modeId === 'approve-all'
      ? ['--permission-mode', 'bypassPermissions']
      : modeId === 'ask'
        ? ['--permission-mode', 'default']
        : []
  const leader = args.includes('--no-leader') || args.includes('--leader') ? [] : ['--no-leader']
  return [...mode, 'agent', ...leader, ...args.slice(1)]
}

/** The profile for an agent started by this command, if there is one. */
export function profileFor(command: string): AgentProfile | undefined {
  // Either kind of separator: a Windows path means the same on any machine reading it.
  const name = (command.split(/[\\/]/).pop() ?? command)
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase()
  return name === 'grok' ? grokProfile() : undefined
}

function readGrokConfig(): string | undefined {
  const home = process.env.GROK_HOME ?? path.join(os.homedir(), '.grok')
  try {
    return readFileSync(path.join(home, 'config.toml'), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The approval mode in Grok's config: `[ui] permission_mode` (or the older `yolo = true`).
 * Undefined when unset or when it names a mode this app has no choice for.
 */
export function grokMode(toml: string | undefined): string | undefined {
  if (!toml) return undefined
  let inUi = false
  let mode: string | undefined
  let yolo = false
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inUi = line === '[ui]'
      continue
    }
    if (!inUi) continue
    const value = /^(\w+)\s*=\s*(?:"([^"]*)"|(\w+))/.exec(line)
    if (!value) continue
    if (value[1] === 'permission_mode') mode = value[2] ?? value[3]
    if (value[1] === 'yolo') yolo = (value[2] ?? value[3]) === 'true'
  }
  const chosen = mode ?? (yolo ? 'always-approve' : 'default')
  if (chosen === 'always-approve' || chosen === 'bypassPermissions') return 'approve-all'
  if (chosen === 'default' || chosen === 'ask') return 'ask'
  return undefined
}
