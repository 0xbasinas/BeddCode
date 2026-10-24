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
