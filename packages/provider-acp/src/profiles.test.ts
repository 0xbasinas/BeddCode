import { describe, expect, it } from 'vitest'
import { approvalSetup } from './permissions.ts'
import { grokLaunchArgs, grokMode, grokProfile, profileFor } from './profiles.ts'

describe('grokMode', () => {
  const ui = (body: string) =>
    `[cli]\ninstaller = "x"\n\n[ui]\n${body}\n\n[mcp_servers.x]\nurl = "u"\n`

  it('reads the approval mode from the [ui] table', () => {
    expect(grokMode(ui('permission_mode = "always-approve"'))).toBe('approve-all')
    expect(grokMode(ui('permission_mode = "bypassPermissions"'))).toBe('approve-all')
    expect(grokMode(ui('permission_mode = "ask"'))).toBe('ask')
    expect(grokMode(ui('permission_mode = "default"'))).toBe('ask')
  })

  it('falls back to the older yolo switch, and to asking when nothing is set', () => {
    expect(grokMode(ui('yolo = true'))).toBe('approve-all')
    expect(grokMode(ui('yolo = false'))).toBe('ask')
    expect(grokMode('[cli]\ninstaller = "x"\n')).toBe('ask')
  })

  it('ignores the same key in other tables, and modes it has no choice for', () => {
    expect(grokMode('[other]\npermission_mode = "always-approve"\n')).toBe('ask')
    expect(grokMode(ui('permission_mode = "auto"'))).toBeUndefined()
    expect(grokMode(undefined)).toBeUndefined()
  })
})

describe('profiles', () => {
  it('knows grok however it is launched, and nothing else', () => {
    expect(profileFor('grok')).toBeDefined()
    expect(profileFor('C:\\tools\\Grok.exe')).toBeDefined()
    expect(profileFor('goose')).toBeUndefined()
  })

  it("takes the place of the generic choices and starts from the agent's own setting", () => {
    const profile = grokProfile(() => '[ui]\npermission_mode = "always-approve"\n')
    const setup = approvalSetup(undefined, [], profile)
    expect(setup).toMatchObject({ source: 'command', current: 'approve-all' })
    expect(setup.modes.map((m) => m.id)).toEqual(['ask', 'approve-all'])
    // The command is how a change is sent, not something to show.
    expect(setup.modes[0]).not.toHaveProperty('command')
  })

  it('still lets the agent say it itself when it reports modes', () => {
    const profile = grokProfile(() => undefined)
    const legacy = { availableModes: [{ id: 'default', name: 'Default' }] }
    expect(approvalSetup(legacy, [], profile).source).toBe('modes')
  })
})

describe('grokLaunchArgs', () => {
  it('starts in the chosen mode by flag, before `agent`, in its own process', () => {
    expect(grokLaunchArgs(['agent', 'stdio'], 'ask')).toEqual([
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio',
    ])
    expect(grokLaunchArgs(['agent', 'stdio'], 'approve-all')).toEqual([
      '--permission-mode',
      'bypassPermissions',
      'agent',
      '--no-leader',
      'stdio',
    ])
  })

  it('leaves the mode to the agent when none was chosen, and respects an explicit leader choice', () => {
    expect(grokLaunchArgs(['agent', 'stdio'], undefined)).toEqual(['agent', '--no-leader', 'stdio'])
    expect(grokLaunchArgs(['agent', '--leader', 'stdio'], 'ask')).toEqual([
      '--permission-mode',
      'default',
      'agent',
      '--leader',
      'stdio',
    ])
  })

  it('does not touch a command that is not `grok agent ...`', () => {
    expect(grokLaunchArgs(['--model', 'x', 'agent', 'stdio'], 'ask')).toEqual([
      '--model',
      'x',
      'agent',
      'stdio',
    ])
    expect(grokLaunchArgs([], 'ask')).toEqual([])
  })
})
