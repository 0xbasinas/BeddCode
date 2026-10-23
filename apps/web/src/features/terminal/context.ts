/** Preserve provenance without guessing which command produced an arbitrary scrollback selection. */
export function terminalContext(
  session: { id?: string; title: string },
  terminal: { id: string; shell: string; cwd: string },
  text: string,
): string {
  return [
    'Selected terminal text',
    session.id ? `Session: ${session.title} (${session.id})` : `Project: ${session.title}`,
    `Terminal: ${terminal.id}`,
    `Shell: ${terminal.shell}`,
    `Working directory: ${terminal.cwd}`,
    `Captured: ${new Date().toISOString()}`,
    '',
    '--- Selection ---',
    text,
  ].join('\n')
}
