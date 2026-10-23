import { useSession, useSessionHostKey } from './store'

/** Where a session works: its host, its folder, and the session itself. Panes read live state from there. */
export function useWorkspace(sessionId: string) {
  const session = useSession(sessionId)
  const hostKey = useSessionHostKey(sessionId)
  return { session, hostKey, cwd: session?.cwd }
}
