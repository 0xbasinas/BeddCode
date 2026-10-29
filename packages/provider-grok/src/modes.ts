import type { PermissionModeOption } from '@beddcode/contracts'

/**
 * A headless Grok run cannot stop and ask, so each mode is a fixed policy handed to Grok's own
 * permission system when the run starts. `flags` are the command-line arguments for it.
 */
export interface GrokMode extends PermissionModeOption {
  flags: string[]
}

/** The tools a read-only run may use: nothing that changes files or runs commands. */
const READ_ONLY_TOOLS = 'read_file,grep,list_dir,web_search'

export const grokModes: GrokMode[] = [
  {
    id: 'accept-edits',
    label: 'Auto-accept edits',
    description: 'File edits go through. Anything else Grok would ask about is refused.',
    flags: ['--permission-mode', 'acceptEdits'],
  },
  {
    id: 'read-only',
    label: 'Read only',
    description: 'Grok can look around and search, but cannot change files or run commands.',
    flags: [
      '--permission-mode',
      'dontAsk',
      '--tools',
      READ_ONLY_TOOLS,
      '--disallowed-tools',
      'Agent',
    ],
  },
  {
    id: 'full-access',
    label: 'Full access',
    description: 'No prompts at all. Use only in a sandbox.',
    dangerous: true,
    flags: ['--permission-mode', 'bypassPermissions'],
  },
]

export const DEFAULT_MODE = 'accept-edits'

export function modeFlags(id: string | undefined): string[] {
  return (grokModes.find((m) => m.id === id) ?? grokModes[0]!).flags
}

/** What the UI shows: the modes without their command-line detail. */
export const grokModeOptions: PermissionModeOption[] = grokModes.map(
  ({ flags: _flags, ...option }) => option,
)

/**
 * The flags for a run that only turns supplied text into text: no shell, no edits, one step. Deny
 * rules win over every other setting, so even a user config that allows tools cannot widen this.
 */
export const TEXT_ONLY_FLAGS = [
  '--permission-mode',
  'dontAsk',
  '--max-turns',
  '1',
  '--no-subagents',
  '--no-plan',
  '--disable-web-search',
  '--deny',
  'Bash',
  '--deny',
  'Edit',
  '--deny',
  'Write',
]
