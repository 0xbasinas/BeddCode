import { describe, expect, it } from 'vitest'
import type { ConfigOption } from '@beddcode/contracts'
import { CLIENT_MODES, allowOption, approvalSetup, isHostTool } from './permissions.ts'

const MODE: ConfigOption = {
  id: 'mode',
  name: 'Session Mode',
  category: 'mode',
  type: 'select',
  value: 'ask',
  choices: [
    { value: 'ask', name: 'Ask', description: 'Request permission first' },
    { value: 'code', name: 'Code' },
  ],
}
const MODEL: ConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  value: 'm1',
  choices: [{ value: 'm1', name: 'M1' }],
}
const LEGACY = {
  currentModeId: 'plan',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'plan', name: 'Plan', description: 'Read only' },
  ],
}

describe('approvalSetup', () => {
  it('takes the mode config option, and leaves the other settings alone', () => {
    const setup = approvalSetup(undefined, [MODEL, MODE])
    expect(setup).toMatchObject({
      source: 'config',
      optionId: 'mode',
      current: 'ask',
      modes: [
        { id: 'ask', label: 'Ask', description: 'Request permission first' },
        { id: 'code', label: 'Code' },
      ],
    })
    expect(setup.rest).toEqual([MODEL])
  })

  it('prefers the config option over the older modes when an agent sends both', () => {
    expect(approvalSetup(LEGACY, [MODE]).source).toBe('config')
  })

  it("falls back to the older modes list, keeping the agent's current mode", () => {
    const setup = approvalSetup(LEGACY, [MODEL])
    expect(setup).toMatchObject({ source: 'modes', current: 'plan' })
    expect(setup.modes.map((m) => m.id)).toEqual(['default', 'plan'])
    expect(setup.rest).toEqual([MODEL])
  })

  it("offers the app's own two choices when the agent has no modes at all", () => {
    const setup = approvalSetup(undefined, [MODEL])
    expect(setup).toMatchObject({ source: 'client', current: 'ask', modes: CLIENT_MODES })
    expect(CLIENT_MODES.find((m) => m.id === 'approve-all')?.dangerous).toBe(true)
    expect(setup.rest).toEqual([MODEL])
  })

  it('ignores a mode option that has no choices, and one that is not a select', () => {
    expect(approvalSetup(undefined, [{ ...MODE, choices: [] }]).source).toBe('client')
    expect(approvalSetup(undefined, [{ ...MODE, type: 'boolean', value: true }]).source).toBe(
      'client',
    )
  })
})

describe('allowOption', () => {
  it('allows once if it can, otherwise always, otherwise nothing', () => {
    const once = { kind: 'allow_once', id: 1 }
    const always = { kind: 'allow_always', id: 2 }
    const no = { kind: 'reject_once', id: 3 }
    expect(allowOption([no, always, once])).toBe(once)
    expect(allowOption([no, always])).toBe(always)
    expect(allowOption([no])).toBeUndefined()
  })
})

describe('isHostTool', () => {
  const own = ['beddcode']
  it('knows the host tools by name, raw input or server', () => {
    expect(isHostTool({ title: 'beddcode__browser_click' }, own)).toBe(true)
    expect(
      isHostTool({ title: 'use_tool', rawInput: { tool_name: 'beddcode__browser_type' } }, own),
    ).toBe(true)
    expect(
      isHostTool(
        { title: 'x', rawInput: { server_name: 'beddcode', tool_name: 'browser_snapshot' } },
        own,
      ),
    ).toBe(true)
    expect(isHostTool({ title: 'mcp__beddcode__start_session' }, own)).toBe(true)
  })
  it('leaves everything else to the user', () => {
    expect(isHostTool({ title: 'beddcode__browser_click' }, [])).toBe(false)
    expect(isHostTool({ title: 'Run rm -rf beddcode__x' }, own)).toBe(false)
    expect(
      isHostTool({ title: 'other__browser_click', rawInput: { server_name: 'other' } }, own),
    ).toBe(false)
    expect(isHostTool({ title: 'use_tool', rawInput: { tool_name: 'evilbeddcode__x' } }, own)).toBe(
      false,
    )
  })
})
