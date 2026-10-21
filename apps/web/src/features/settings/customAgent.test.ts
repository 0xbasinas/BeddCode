import { describe, expect, it } from 'vitest'
import { customAgentInput } from './customAgent.ts'

describe('custom ACP agent input', () => {
  it('preserves Windows paths, spaces, and literal shell characters as separate arguments', () => {
    expect(
      customAgentInput(
        ' My agent ',
        'C:\\Program Files\\Agent\\agent.exe',
        'acp\r\n--config\r\nC:\\My Files\\agent.json\r\n$(literal); & text',
        [{ name: 'MODEL', value: 'a=b' }],
      ),
    ).toEqual({
      label: 'My agent',
      command: 'C:\\Program Files\\Agent\\agent.exe',
      args: ['acp', '--config', 'C:\\My Files\\agent.json', '$(literal); & text'],
      env: { MODEL: 'a=b' },
    })
  })

  it('accepts an empty environment value and ignores unused rows', () => {
    expect(
      customAgentInput('Agent', 'agent', '', [
        { name: '', value: '' },
        { name: 'EMPTY', value: '' },
      ]).env,
    ).toEqual({ EMPTY: '' })
  })

  it.each([
    ['', 'agent', [], 'name'],
    ['Agent', 'agent\nother', [], 'executable'],
    ['Agent', '', [], 'executable'],
    ['Agent', 'agent', [{ name: 'BAD-NAME', value: 'x' }], 'Environment names'],
    ['Agent', 'agent', [{ name: '', value: 'x' }], 'Environment names'],
    [
      'Agent',
      'agent',
      [
        { name: 'MODEL', value: 'x' },
        { name: 'MODEL', value: 'y' },
      ],
      'listed twice',
    ],
  ] as const)('rejects invalid input', (name, command, env, message) => {
    expect(() => customAgentInput(name, command, '', [...env])).toThrow(message)
  })
})
