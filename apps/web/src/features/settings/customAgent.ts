import type { RpcParams } from '@beddcode/contracts'

export interface EnvironmentVariable {
  name: string
  value: string
}

/** Each argument is a separate line, so Windows paths and spaces never need shell quoting. */
export function customAgentInput(
  label: string,
  command: string,
  args: string,
  variables: EnvironmentVariable[],
): Extract<RpcParams<'agents.add'>, { command: string }> {
  if (!label.trim()) throw new Error('Enter a name for this agent.')
  if (!command.trim() || /[\r\n]/.test(command))
    throw new Error('Enter one executable name or absolute path.')
  const entries: [string, string][] = []
  const names = new Set<string>()
  for (const variable of variables) {
    const name = variable.name.trim()
    if (!name && !variable.value) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(
        'Environment names must start with a letter or underscore and contain only letters, numbers, and underscores.',
      )
    if (names.has(name)) throw new Error(`Environment variable ${name} is listed twice.`)
    names.add(name)
    entries.push([name, variable.value])
  }
  return {
    label: label.trim(),
    command: command.trim(),
    args: args.split(/\r?\n/).filter((arg) => arg.length > 0),
    env: Object.fromEntries(entries),
  }
}
