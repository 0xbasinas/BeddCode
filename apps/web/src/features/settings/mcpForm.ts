import type { McpServerInput } from '@beddcode/contracts'

export interface McpForm {
  name: string
  kind: 'stdio' | 'http' | 'sse'
  command: string
  /** One argument per line. */
  args: string
  /** `NAME=value`, one per line. */
  env: string
  url: string
  scope?: 'user' | 'project' | 'local'
}

export const emptyMcpForm = (): McpForm => ({
  name: '',
  kind: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
})

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

/** `NAME=value` lines to a record; a line without `=` or a name is a mistake worth reporting. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of lines(text)) {
    const at = line.indexOf('=')
    const name = at > 0 ? line.slice(0, at).trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`"${line}" is not NAME=value`)
    }
    env[name] = line.slice(at + 1)
  }
  return env
}

/** Turns what was typed into the request, or explains what is missing in plain words. */
export function mcpInputFromForm(form: McpForm): McpServerInput {
  const name = form.name.trim()
  if (!name) throw new Error('Give the server a name')
  if (!/^[\w.-]+$/.test(name)) {
    throw new Error('The name can use letters, digits, dots, dashes and underscores')
  }

  if (form.kind === 'stdio') {
    const command = form.command.trim()
    if (!command) throw new Error('Enter the command that starts the server')
    const env = parseEnv(form.env)
    return {
      name,
      transport: 'stdio',
      command,
      args: lines(form.args),
      env: Object.keys(env).length > 0 ? env : undefined,
      scope: form.scope,
    }
  }

  const url = form.url.trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Enter the server address, like https://example.com/mcp')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The address must start with https:// or http://')
  }
  return { name, transport: form.kind, url, scope: form.scope }
}
