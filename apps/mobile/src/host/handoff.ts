import { handoffPrompt, type HandoffFile, type SessionView } from '@beddcode/client-runtime'

import { hostRequest } from './store'

/** Build the note a fallback agent should read, including a short look at uncommitted files. */
export async function prepareHandoff(
  hostKey: string,
  session: SessionView,
  agentLabel?: string,
  reason?: string,
): Promise<string> {
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
  return handoffPrompt(session, { agentLabel, reason, files })
}
