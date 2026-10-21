import { describe, expect, it } from 'vitest'
import { emptyMcpForm, mcpInputFromForm, parseEnv } from './mcpForm.ts'

const form = (patch: Partial<ReturnType<typeof emptyMcpForm>>) => ({ ...emptyMcpForm(), ...patch })

describe('parseEnv', () => {
  it('reads NAME=value lines, keeping everything after the first equals sign', () => {
    expect(parseEnv('A=1\n  B = two words\r\nTOKEN=abc=def==\n\n')).toEqual({
      A: '1',
      B: ' two words',
      TOKEN: 'abc=def==',
    })
    expect(parseEnv('')).toEqual({})
  })

  it('rejects lines that are not assignments', () => {
    expect(() => parseEnv('just text')).toThrow('"just text" is not NAME=value')
    expect(() => parseEnv('=value')).toThrow('not NAME=value')
    expect(() => parseEnv('1BAD=x')).toThrow('not NAME=value')
  })
})

describe('mcpInputFromForm', () => {
  it('builds a local server from a command, its arguments and its environment', () => {
    expect(
      mcpInputFromForm(
        form({
          name: ' files ',
          command: ' npx ',
          args: '-y\n@modelcontextprotocol/server-filesystem\n/tmp/my dir',
          env: 'KEY=value',
          scope: 'project',
        }),
      ),
    ).toEqual({
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/my dir'],
      env: { KEY: 'value' },
      scope: 'project',
    })
    expect(mcpInputFromForm(form({ name: 'a', command: 'x' }))).toMatchObject({
      args: [],
      env: undefined,
    })
  })

  it('builds a remote server from its address', () => {
    expect(
      mcpInputFromForm(form({ name: 'sentry', kind: 'http', url: 'https://mcp.sentry.dev/mcp' })),
    ).toEqual({
      name: 'sentry',
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      scope: undefined,
    })
    expect(
      mcpInputFromForm(form({ name: 's', kind: 'sse', url: 'http://localhost:8080/sse' })),
    ).toMatchObject({
      transport: 'sse',
    })
  })

  it('says what is missing in plain words', () => {
    expect(() => mcpInputFromForm(form({}))).toThrow('Give the server a name')
    expect(() => mcpInputFromForm(form({ name: 'bad name' }))).toThrow('letters, digits')
    expect(() => mcpInputFromForm(form({ name: 'a' }))).toThrow('command')
    expect(() => mcpInputFromForm(form({ name: 'a', kind: 'http', url: 'nope' }))).toThrow(
      'server address',
    )
    expect(() => mcpInputFromForm(form({ name: 'a', kind: 'http', url: 'ftp://x/y' }))).toThrow(
      'https://',
    )
    expect(() => mcpInputFromForm(form({ name: 'a', command: 'x', env: 'oops' }))).toThrow(
      'NAME=value',
    )
  })
})
