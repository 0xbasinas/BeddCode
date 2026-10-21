import type { PermissionModeOption } from '@beddcode/contracts'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'

export interface CodexMode extends PermissionModeOption {
  approvalPolicy: ApprovalPolicy
  sandbox: SandboxMode
}

/**
 * Each mode is a pair of Codex's own settings (approval policy + sandbox); Codex enforces it.
 * Nothing here decides what is allowed.
 */
export const codexModes: CodexMode[] = [
  {
    id: 'ask',
    label: 'Ask before edits',
    description: 'Asks before changing files or running commands',
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  },
  {
    id: 'auto',
    label: 'Auto-accept edits',
    description: 'Edits in the workspace go through; asks to go beyond the sandbox',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  },
  {
    id: 'read-only',
    label: 'Read only',
    description: 'Can read and answer, but not change anything',
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
  },
  {
    id: 'full',
    label: 'Full access',
    description: 'No prompts at all. Use only in a sandbox.',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    dangerous: true,
  },
]

export const DEFAULT_MODE_ID = 'ask'

export function modeById(id: string | undefined): CodexMode {
  const mode = codexModes.find((m) => m.id === (id ?? DEFAULT_MODE_ID))
  if (!mode) throw new Error(`Unknown permission mode: ${id}`)
  return mode
}

/** The turn-level override form of a sandbox mode. */
export function sandboxPolicy(mode: SandboxMode): Record<string, unknown> {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false }
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
  }
}
