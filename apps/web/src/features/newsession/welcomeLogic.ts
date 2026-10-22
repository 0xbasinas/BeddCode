/**
 * Whether the new-session route shows the first-run checklist instead of the composer. It stays up
 * until the first session exists, unless a folder was picked, the user skipped it, or the user
 * asked for a new session outright (the sidebar's New session, which used to do nothing here
 * because it led to the very page already showing).
 */
export function showWelcome(state: {
  initialProject?: string
  compose?: boolean
  synced: boolean
  hasSessions: boolean
  setupSkipped: boolean
}): boolean {
  return (
    !state.initialProject &&
    !state.compose &&
    state.synced &&
    !state.hasSessions &&
    !state.setupSkipped
  )
}
