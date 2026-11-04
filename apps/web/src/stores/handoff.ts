import type { SessionView } from '@beddcode/client-runtime'
import { handoffPrompt, type HandoffFile } from '@beddcode/client-runtime'
import { hostRequest } from './host.ts'

interface PendingHandoff {
  hostKey: string
  text: string
  source?: { sessionId: string; cwd: string; instanceId: string; active: boolean }
}

let pending: PendingHandoff | undefined

export function setHandoff(hostKey: string, text: string, source?: PendingHandoff['source']) {
  pending = { hostKey, text, source }
}

export function peekHandoff(hostKey: string): PendingHandoff | undefined {
  return pending?.hostKey === hostKey ? pending : undefined
}

export function clearHandoff() {
  pending = undefined
}

/** Capture the current working tree, including staged and untracked files, for review. */
export async function prepareHandoff(
  hostKey: string,
  session: SessionView,
  agentLabel?: string,
  savePending = true,
  reason?: string,
) {
  let files: HandoffFile[] = []
  try {
    const status = await hostRequest(hostKey, 'git.status', { cwd: session.cwd })
    files = await Promise.all(
      status.files.slice(0, 30).map(async (file) => {
        const diff = await hostRequest(hostKey, 'git.diff', {
          cwd: session.cwd,
          path: file.path,
        }).catch(() => undefined)
        return { path: file.path, status: file.status, patch: diff?.patch }
      }),
    )
  } catch {
    /* Without Git the note simply has no changed-files section. */
  }
  const text = handoffPrompt(session, { agentLabel, reason, files })
  if (savePending)
    setHandoff(hostKey, text, {
      sessionId: session.id,
      cwd: session.cwd,
      instanceId: session.instanceId,
      active: session.status === 'running' || session.status === 'needs-you',
    })
  return text
}
