/**
 * A message prepared for the new-session composer when the user continues a session with
 * another agent. The composer of the host it was made for reads it once, then clears it.
 */
let pending: { hostKey: string; text: string } | undefined

export function setHandoff(hostKey: string, text: string) {
  pending = { hostKey, text }
}

export function peekHandoff(hostKey: string): string | undefined {
  return pending?.hostKey === hostKey ? pending.text : undefined
}

export function clearHandoff() {
  pending = undefined
}
