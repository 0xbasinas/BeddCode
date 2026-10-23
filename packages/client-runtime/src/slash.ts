import type { SlashCommand } from '@beddcode/contracts'

const MAX_SHOWN = 8

/**
 * The commands to offer while the whole message is a half-typed `/command`. Anything after a
 * space means the command is chosen already, so the menu goes away.
 */
export function matchCommands(text: string, commands: SlashCommand[] | undefined): SlashCommand[] {
  const typed = /^\/([\w.:-]*)$/.exec(text)?.[1]
  if (typed === undefined || !commands || commands.length === 0) return []
  const q = typed.toLowerCase()
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q))
  const rest = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q),
  )
  return [...starts, ...rest].slice(0, MAX_SHOWN)
}

/** What the message becomes when a command is picked: the command, ready for its argument. */
export const insertCommand = (command: SlashCommand) => `/${command.name} `
