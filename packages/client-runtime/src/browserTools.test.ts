import { describe, expect, it } from 'vitest'
import { browserToolName, browserToolView } from './browserTools.ts'
import type { Tool } from './toolSummary.ts'

const tool = (t: Partial<Tool> & { title: string }) =>
  ({ kind: 'tool', id: 't', status: 'ok', ...t }) as unknown as Tool

describe('browserToolName', () => {
  it('knows each agent’s way of naming the tools', () => {
    expect(browserToolName({ title: 'Using beddcode · browser_click' })).toBe('browser_click')
    expect(browserToolName({ title: 'mcp__beddcode__browser_snapshot' })).toBe('browser_snapshot')
    expect(browserToolName({ title: 'beddcode__browser_type' })).toBe('browser_type')
    expect(browserToolName({ title: 'browser_navigate' })).toBe('browser_navigate')
    expect(
      browserToolName({ title: 'use_tool', input: '{"tool_name":"beddcode__browser_console"}' }),
    ).toBe('browser_console')
  })
  it('leaves other tools alone', () => {
    expect(browserToolName({ title: 'Run npm test' })).toBeUndefined()
    expect(
      browserToolName({ title: 'Search tools: "beddcode browser_tabs browser_click"' }),
    ).toBeUndefined()
    expect(
      browserToolName({ title: 'use_tool', input: '{"tool_name":"github__list"}' }),
    ).toBeUndefined()
    expect(browserToolName({ title: 'Using beddcode · start_session' })).toBeUndefined()
  })
})

describe('browserToolView', () => {
  it('reads the picture, the page and what happened', () => {
    const v = browserToolView(
      tool({
        title: 'Using beddcode · browser_click',
        input: '{"ref":"e4"}',
        output:
          'image: /tmp/a/1.jpg\nTab 1. Clicked button "Place order".\nPage: Checkout — http://localhost:5199/form.html',
      }),
    )
    expect(v).toEqual({
      name: 'browser_click',
      summary: 'Clicked button "Place order"',
      page: { title: 'Checkout', url: 'http://localhost:5199/form.html' },
      image: '/tmp/a/1.jpg',
      detail: 'Tab 1. Clicked button "Place order".',
      failed: false,
    })
  })
  it('unwraps MCP content blocks and Grok’s use_tool', () => {
    const blocks = browserToolView(
      tool({
        title: 'mcp__beddcode__browser_snapshot',
        output: JSON.stringify([{ type: 'text', text: 'Page: x — http://a/\n- main' }]),
      }),
    )
    expect(blocks).toMatchObject({
      summary: 'Read page',
      page: { url: 'http://a/' },
      detail: '- main',
    })
    const grok = browserToolView(
      tool({
        title: 'beddcode__browser_type',
        input: JSON.stringify({
          tool_name: 'beddcode__browser_type',
          tool_input: { ref: 'e1', text: 'Ada' },
        }),
        status: 'running',
        output: undefined,
      }),
    )
    expect(grok?.summary).toBe('Type "Ada" into e1')
    const failed = browserToolView(
      tool({
        title: 'beddcode__browser_wait_for',
        status: 'failed',
        input: JSON.stringify({
          tool_name: 'beddcode__browser_wait_for',
          tool_input: { text: 'Done' },
        }),
        output: JSON.stringify({
          type: 'MCP',
          tool_name: 'browser_wait_for',
          output: { Error: 'Timed out after 10s.' },
        }),
      }),
    )
    expect(failed).toMatchObject({
      failed: true,
      summary: 'Wait for "Done"',
      detail: 'Timed out after 10s.',
    })
  })
})
