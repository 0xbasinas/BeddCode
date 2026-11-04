import type { SessionView } from '@beddcode/client-runtime'
import { handoffPrompt } from '@beddcode/client-runtime'
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
export async function prepareHandoff(hostKey: string, session: SessionView, agentLabel?: string) {
  let changes = ''
  try {
    const status = await hostRequest(hostKey, 'git.status', { cwd: session.cwd })
    const files = status.files.slice(0, 30)
    const diffs = await Promise.all(
      files.map((file) =>
        hostRequest(hostKey, 'git.diff', { cwd: session.cwd, path: file.path }).catch(() => null),
      ),
    )
    let remaining = 24_000
    const patches = files
      .map((file, i) => {
        const diff = diffs[i]
        const patch = diff?.patch ?? ''
        const included = patch.slice(0, Math.max(0, remaining))
        remaining -= included.length
        return `\n### ${file.path} (${file.status})\n${included}${!diff || diff.truncated || included.length < patch.length ? '\n[Diff unavailable or truncated; inspect the working tree.]' : ''}`
      })
      .join('\n')
    changes = `\n\nCurrent uncommitted changes:${files.length ? patches : '\nNone.'}${status.files.length > files.length ? '\n[Additional files omitted; inspect the working tree.]' : ''}`
  } catch {
    changes = '\n\nCurrent uncommitted changes: unavailable; inspect the working tree.'
  }
  setHandoff(hostKey, handoffPrompt(session, { agentLabel }) + changes, {
    sessionId: session.id,
    cwd: session.cwd,
    instanceId: session.instanceId,
    active: session.status === 'running' || session.status === 'needs-you',
  })
}
