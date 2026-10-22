import { describe, expect, it } from 'vitest'
import {
  approvalWait,
  defaultOpen,
  formatDuration,
  ranWithoutAsking,
  summarizeTools,
  toolDuration,
  toolLabel,
  toolPhase,
  type Tool,
} from './toolSummary.ts'

const tool = (patch: Partial<Tool>): Tool => ({
  kind: 'tool',
  id: 't',
  title: 'Running Bash: ls',
  toolKind: 'command',
  status: 'ok',
  ...patch,
})

describe('formatDuration', () => {
  it.each([
    [0, '1 ms'],
    [820, '820 ms'],
    [3400, '3.4 s'],
    [12_400, '12 s'],
    [59_600, '60 s'],
    [125_000, '2 m 05 s'],
  ])('%d ms is %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
})

describe('toolDuration', () => {
  it('measures finished tools by their own times and running ones against now', () => {
    expect(toolDuration(tool({ startedAt: 1000, endedAt: 3500 }))).toBe(2500)
    expect(toolDuration(tool({ status: 'running', startedAt: 1000 }), 4000)).toBe(3000)
    expect(toolDuration(tool({}))).toBeUndefined()
    expect(toolDuration(tool({ startedAt: 5000, endedAt: 4000 }))).toBe(0)
  })
})

describe('summarizeTools', () => {
  it('says what a group did, in a fixed order', () => {
    expect(
      summarizeTools([
        tool({ toolKind: 'read' }),
        tool({ toolKind: 'command' }),
        tool({ toolKind: 'read' }),
        tool({ toolKind: 'command' }),
        tool({ toolKind: 'search' }),
        tool({ toolKind: 'other' }),
        tool({ toolKind: 'edit' }),
      ]),
    ).toBe('Ran 2 commands, read 2 files, edited 1 file, searched 1 time, used 1 tool')
    expect(summarizeTools([tool({ toolKind: 'read' })])).toBe('Read 1 file')
    expect(summarizeTools([])).toBe('No tools')
  })
})

describe('toolLabel', () => {
  it('splits a title into a verb and what it acted on, by state', () => {
    expect(toolLabel({ title: 'Running Bash: pnpm test', status: 'ok' })).toEqual({
      verb: 'Ran',
      target: 'pnpm test',
      prompt: '$',
    })
    expect(toolLabel({ title: 'Running Bash: pnpm test', status: 'running' }).verb).toBe('Running')
    expect(toolLabel({ title: 'Running Bash: pnpm test', status: 'cancelled' }).verb).toBe(
      'Stopped',
    )
    expect(toolLabel({ title: 'Reading src/a.ts', status: 'ok' })).toMatchObject({
      verb: 'Read',
      target: 'src/a.ts',
    })
    expect(toolLabel({ title: 'Reading src/a.ts', status: 'running' }).verb).toBe('Reading')
    expect(toolLabel({ title: 'Editing src/a.ts', status: 'ok' }).verb).toBe('Edited')
    expect(toolLabel({ title: 'Editing src/a.ts', status: 'running' }).verb).toBe('Editing')
    expect(toolLabel({ title: 'Searching refillAt', status: 'ok' })).toMatchObject({
      verb: 'Searched',
      target: 'refillAt',
    })
    expect(toolLabel({ title: 'Searching refillAt', status: 'running' }).verb).toBe('Searching')
  })

  it('leaves unfamiliar titles whole', () => {
    expect(toolLabel({ title: 'Using github · create issue', status: 'ok' })).toEqual({
      verb: '',
      target: 'Using github · create issue',
      prompt: '',
    })
  })
})

describe('defaultOpen', () => {
  it('opens short runs, and long ones only while something is wrong or still going', () => {
    const done = [tool({}), tool({}), tool({})]
    expect(defaultOpen(done)).toBe(false)
    expect(defaultOpen(done.slice(0, 2))).toBe(true)
    expect(defaultOpen([...done, tool({ status: 'running' })])).toBe(true)
    expect(defaultOpen([...done, tool({ status: 'failed' })])).toBe(true)
    expect(defaultOpen([...done, tool({ status: 'cancelled' })])).toBe(true)
  })
})

describe('approval timing', () => {
  const asked = (approval: Tool['approval'], patch: Partial<Tool> = {}) =>
    tool({ status: 'running', startedAt: 1_000, approval, ...patch })

  it('does not count the wait for the user as run time', () => {
    // Grok asked at 1 s, the user answered at 17 s, the command finished 30 ms later.
    const done = asked(
      { requestId: 'r', requestedAt: 1_005, resolvedAt: 17_000, outcome: 'allow' },
      { status: 'ok', endedAt: 17_030 },
    )
    expect(toolDuration(done)).toBe(30)
    expect(approvalWait(done)).toBe(15_995)
  })

  it('has no run time while still waiting, and counts the wait against now', () => {
    const waiting = asked({ requestId: 'r', requestedAt: 1_000 })
    expect(toolDuration(waiting, 5_000)).toBeUndefined()
    expect(approvalWait(waiting, 5_000)).toBe(4_000)
    expect(approvalWait(tool({ startedAt: 1, endedAt: 2 }))).toBeUndefined()
  })

  it('shows the answer at once while the agent catches up', () => {
    expect(toolPhase(asked({ requestId: 'r', requestedAt: 1 }))).toBe('awaiting-approval')
    expect(
      toolPhase(asked({ requestId: 'r', requestedAt: 1, resolvedAt: 2, outcome: 'allow' })),
    ).toBe('approved')
    expect(
      toolPhase(asked({ requestId: 'r', requestedAt: 1, resolvedAt: 2, outcome: 'deny' })),
    ).toBe('denied')
    expect(
      toolPhase(
        asked(
          { requestId: 'r', requestedAt: 1, resolvedAt: 2, outcome: 'allow' },
          { status: 'ok' },
        ),
      ),
    ).toBe('ok')
    expect(toolPhase(tool({ status: 'running' }))).toBe('running')
  })

  it('points out commands and edits that ran without a prompt, not reads', () => {
    expect(ranWithoutAsking(tool({ asked: false }))).toBe(true)
    expect(ranWithoutAsking(tool({ asked: false, toolKind: 'edit' }))).toBe(true)
    expect(ranWithoutAsking(tool({ asked: false, toolKind: 'read' }))).toBe(false)
    expect(ranWithoutAsking(tool({ asked: true }))).toBe(false)
    // Providers that do not report it say nothing.
    expect(ranWithoutAsking(tool({}))).toBe(false)
  })
})

describe('toolLabel for ACP titles', () => {
  it('reads Grok-style "Execute `cmd`" and "Edit `path`" titles', () => {
    expect(toolLabel({ title: 'Execute `ls -la`', status: 'ok' })).toEqual({
      verb: 'Ran',
      target: 'ls -la',
      prompt: '$',
    })
    expect(toolLabel({ title: 'Edit `/w/hello.py`', status: 'running' })).toEqual({
      verb: 'Editing',
      target: '/w/hello.py',
      prompt: '',
    })
    expect(toolLabel({ title: 'Read `/w/a.md`', status: 'ok' }).verb).toBe('Read')
  })
})
