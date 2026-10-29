import type { TerminalInfo } from '@beddcode/contracts'

/**
 * Where a new terminal goes in the tab strip: a script run again takes its earlier tab's place
 * (the host has closed that one), anything else is added at the end.
 */
export function placeTerminal(list: TerminalInfo[], info: TerminalInfo): TerminalInfo[] {
  const at = info.scriptId ? list.findIndex((t) => t.scriptId === info.scriptId) : -1
  if (at < 0) return [...list.filter((t) => t.id !== info.id), info]
  return list
    .map((t, i) => (i === at ? info : t))
    .filter((t, i) => i === at || (t.scriptId !== info.scriptId && t.id !== info.id))
}

/**
 * Applies a `term.changed` frame: the tab is updated where it is, added the way a new one would be,
 * or removed when `info` is null.
 */
export function applyTerminalChange(
  list: TerminalInfo[],
  id: string,
  info: TerminalInfo | null,
): TerminalInfo[] {
  if (!info) return list.filter((t) => t.id !== id)
  return list.some((t) => t.id === id)
    ? list.map((t) => (t.id === id ? info : t))
    : placeTerminal(list, info)
}

/**
 * Whether a change should bring its tab to the front: an agent tab that just appeared or started a
 * command, unless the user is looking at a shell of their own.
 */
export function shouldFollow(
  before: TerminalInfo | undefined,
  after: TerminalInfo | null,
  shown: TerminalInfo | undefined,
): boolean {
  if (!after?.agent || after.exited !== undefined) return false
  const started = !before || (Boolean(after.agent.running) && !before.agent?.running)
  if (!started) return false
  return !shown || Boolean(shown.agent) || shown.exited !== undefined || !before
}
