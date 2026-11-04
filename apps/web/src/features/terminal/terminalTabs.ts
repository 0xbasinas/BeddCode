import type { TerminalInfo } from '@beddcode/contracts'

/**
 * Add a terminal or update an existing one without hiding earlier command output.
 */
export function placeTerminal(list: TerminalInfo[], info: TerminalInfo): TerminalInfo[] {
  if (list.some((t) => t.id === info.id)) return list.map((t) => (t.id === info.id ? info : t))
  return [...list, info]
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

/** What a tab is called: the user's name for it, else what it was opened for, else its shell. */
export function tabLabel(t: Pick<TerminalInfo, 'name' | 'title' | 'shell'>): string {
  return t.name || t.title || t.shell
}
