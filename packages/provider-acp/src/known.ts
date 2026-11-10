/**
 * Launch commands for ACP agents that ship their own ACP mode, so BeddCode can notice which are
 * installed and add one in a click. The list is adapted from acpx (https://github.com/openclaw/acpx,
 * MIT, © 2025 OpenClaw Team), whose agent registry tracks each agent's real command line.
 *
 * Agents with a native BeddCode adapter (Claude Code, Codex, Grok, Pi, OpenCode) are left out, and
 * so are agents that are only run through `npx`: the public ACP registry covers those.
 */
export interface KnownAgent {
  id: string
  name: string
  /** The executable; the agent counts as installed when this is on PATH. */
  command: string
  args: string[]
  /** Other programs it needs on PATH (a bridge or runtime), all of which must be present. */
  requires?: string[]
  /** Only offered on these platforms (`process.platform` values). */
  platforms?: NodeJS.Platform[]
}

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: 'openclaw', name: 'OpenClaw', command: 'openclaw', args: ['acp'] },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { id: 'cursor', name: 'Cursor', command: 'cursor-agent', args: ['acp'] },
  { id: 'copilot', name: 'GitHub Copilot', command: 'copilot', args: ['--acp', '--stdio'] },
  { id: 'ante', name: 'Ante', command: 'ante', args: ['acp'], requires: ['ante-acp'] },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    command: 'agy_acp_server.exe',
    args: [],
    platforms: ['win32'],
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    command: 'dsh',
    args: ['--profile', 'acp'],
  },
  { id: 'devin', name: 'Devin', command: 'devin', args: ['acp'] },
  {
    id: 'droid',
    name: 'Factory Droid',
    command: 'droid',
    args: ['exec', '--output-format', 'acp'],
  },
  { id: 'fast-agent', name: 'fast-agent', command: 'uvx', args: ['fast-agent-mcp', 'acp'] },
  { id: 'fx', name: 'fx', command: 'fx', args: ['acp'] },
  { id: 'goose', name: 'Goose', command: 'goose', args: ['acp'] },
  { id: 'iflow', name: 'iFlow', command: 'iflow', args: ['--experimental-acp'] },
  { id: 'junie', name: 'Junie', command: 'junie', args: ['--acp=true'] },
  { id: 'kilocode', name: 'Kilo Code', command: 'kilo', args: ['acp'] },
  { id: 'kimi', name: 'Kimi Code', command: 'kimi', args: ['acp'] },
  { id: 'kiro', name: 'Kiro', command: 'kiro-cli-chat', args: ['acp'] },
  { id: 'mcode', name: 'MCode', command: 'mcode', args: ['acp'] },
  {
    id: 'octomind',
    name: 'Octomind',
    command: 'octomind',
    args: ['acp', 'developer:general'],
  },
  { id: 'pool', name: 'Poolside', command: 'pool', args: ['acp'] },
  { id: 'qoder', name: 'Qoder', command: 'qodercli', args: ['--acp'] },
  { id: 'qwen', name: 'Qwen Code', command: 'qwen', args: ['--acp'] },
  { id: 'trae', name: 'Trae', command: 'traecli', args: ['acp', 'serve'] },
  { id: 'zeroclaw', name: 'ZeroClaw', command: 'zeroclaw', args: ['acp'] },
]

export interface KnownAgentStatus extends KnownAgent {
  /** True when the command, and everything it requires, is on PATH. */
  installed: boolean
  /** What is missing from PATH, when not installed. */
  missing: string[]
}

/** Which known agents this machine can start. `resolve` finds an executable on PATH (or not). */
export function detectKnownAgents(
  resolve: (command: string) => string | null,
  platform: NodeJS.Platform = process.platform,
): KnownAgentStatus[] {
  return KNOWN_AGENTS.filter((a) => !a.platforms || a.platforms.includes(platform)).map((a) => {
    const missing = [a.command, ...(a.requires ?? [])].filter((c) => !resolve(c))
    return { ...a, installed: missing.length === 0, missing }
  })
}
