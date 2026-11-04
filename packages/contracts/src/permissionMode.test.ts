import { describe, expect, it } from 'vitest'
import { carryPermissionMode, permissionLevel } from './permissionMode.ts'
import type { PermissionModeOption } from './providers.ts'

const claude: PermissionModeOption[] = [
  { id: 'default', label: 'Ask before edits' },
  { id: 'acceptEdits', label: 'Auto-accept edits' },
  { id: 'plan', label: 'Plan mode' },
  { id: 'bypassPermissions', label: 'Full access', dangerous: true },
]
const grok: PermissionModeOption[] = [
  { id: 'ask', label: 'Ask before tools' },
  { id: 'approve-all', label: 'Always approve', dangerous: true },
]
const grokHeadless: PermissionModeOption[] = [
  { id: 'accept-edits', label: 'Auto-accept edits' },
  { id: 'read-only', label: 'Read only' },
  { id: 'full-access', label: 'Full access', dangerous: true },
]
const codex: PermissionModeOption[] = [
  { id: 'ask', label: 'Ask before edits' },
  { id: 'auto', label: 'Auto-accept edits' },
  { id: 'read-only', label: 'Read only' },
  { id: 'full', label: 'Full access', dangerous: true },
]

describe('permissionLevel', () => {
  it('reads each provider mode', () => {
    expect(claude.map((m) => permissionLevel(m))).toEqual([
      'ask',
      'accept-edits',
      'read-only',
      'full-access',
    ])
    expect(grok.map((m) => permissionLevel(m))).toEqual(['ask', 'full-access'])
    expect(codex.map((m) => permissionLevel(m))).toEqual([
      'ask',
      'accept-edits',
      'read-only',
      'full-access',
    ])
    expect(permissionLevel('mystery')).toBeUndefined()
  })
})

describe('carryPermissionMode', () => {
  it('uses the exact level when the target has it', () => {
    expect(carryPermissionMode('bypassPermissions', grok, 'Grok')).toEqual({
      modeId: 'approve-all',
      level: 'full-access',
      label: 'Full access',
      exact: true,
    })
    expect(carryPermissionMode('acceptEdits', codex)).toMatchObject({ modeId: 'auto', exact: true })
    expect(carryPermissionMode('plan', codex)).toMatchObject({ modeId: 'read-only', exact: true })
  })

  it('goes down to the closest safer mode, never up', () => {
    const r = carryPermissionMode('acceptEdits', grok, 'Grok')
    expect(r).toMatchObject({ modeId: 'ask', exact: false })
    expect(r.note).toBe("Accept edits isn't available in Grok; using Ask before tools.")
    // Full access with no full mode: accept edits is closer than ask.
    const noFull = grokHeadless.filter((m) => m.id !== 'full-access')
    expect(carryPermissionMode('bypassPermissions', noFull, 'Grok')).toMatchObject({
      modeId: 'accept-edits',
      note: "Full access isn't available in Grok; using Accept edits.",
    })
    // Plan on an agent with no read-only mode must not widen to ask.
    expect(carryPermissionMode('plan', grok, 'Grok')).toMatchObject({ exact: false })
    expect(carryPermissionMode('plan', grok, 'Grok').modeId).toBeUndefined()
  })

  it('treats an unknown mode as ask, with a note', () => {
    const r = carryPermissionMode('mystery', claude, 'Claude')
    expect(r).toMatchObject({ modeId: 'default', level: 'ask' })
    expect(r.note).toContain('"mystery"')
  })

  it('carries nothing when there is no current mode or the target reports none', () => {
    expect(carryPermissionMode(undefined, claude)).toEqual({ exact: false })
    expect(carryPermissionMode('default', [])).toEqual({ exact: false })
  })

  it('keeps the same id among equals', () => {
    const twins: PermissionModeOption[] = [
      { id: 'a', label: 'Ask first' },
      { id: 'default', label: 'Ask before edits' },
    ]
    expect(carryPermissionMode('default', twins).modeId).toBe('default')
  })
})
