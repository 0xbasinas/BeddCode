import { describe, expect, it, vi } from 'vitest'
import { primaryLabel, switchRequest } from './SwitchAgent.tsx'

// No DOM test environment is installed, so the dialog's decisions live in pure helpers that are
// exercised here against a mocked host request.
const base = { sessionId: 's1', instanceId: 'grok', model: '', stop: false }

describe('switch agent review step', () => {
  const request = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }))
  const send = (args: Parameters<typeof switchRequest>[0]) =>
    request('session.switchAgent', switchRequest(args))

  it('labels the primary action for each step', () => {
    expect(primaryLabel(true, false)).toBe('Review handoff')
    expect(primaryLabel(true, true)).toBe('Send and switch')
    expect(primaryLabel(false, false)).toBe('Switch')
  })

  it('sends the edited note when reviewing', async () => {
    request.mockClear()
    await send({ ...base, reviewing: true, handoff: '## Goal\nEdited by hand' })
    expect(request).toHaveBeenCalledWith(
      'session.switchAgent',
      expect.objectContaining({ instanceId: 'grok', handoff: '## Goal\nEdited by hand' }),
    )
  })

  it('does not override the handoff when review is off, or after going Back', async () => {
    request.mockClear()
    await send({ ...base, reviewing: false, handoff: '## Goal\nstale draft' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1]).toMatchObject({ handoff: undefined, model: undefined })
  })

  it('passes the chosen model and the pending message', () => {
    expect(
      switchRequest({
        ...base,
        model: 'grok-4',
        pendingMessage: 'go on',
        reviewing: false,
        handoff: '',
      }),
    ).toMatchObject({ model: 'grok-4', pendingMessage: 'go on' })
  })
})
