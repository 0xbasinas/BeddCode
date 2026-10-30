import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LinearKeyStore,
  LinearTools,
  LINEAR_TOOL_DEFINITIONS,
  isLinearToolName,
} from './linearTools.ts'

const setup = (data: unknown, key: string | null = 'lin_api_test') => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'linear-')), 'linear.json')
  const keys = new LinearKeyStore(file)
  if (key) keys.set(key)
  const calls: { headers: Record<string, string>; body: { query: string; variables: any } }[] = []
  const tools = new LinearTools(keys, async (_url, init) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ data }) }
  })
  return { file, keys, tools, calls }
}
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text)

describe('LinearKeyStore', () => {
  it('keeps the key across restarts and clears it', () => {
    const { file, keys } = setup({})
    expect(new LinearKeyStore(file).get()).toBe('lin_api_test')
    keys.set(null)
    expect(new LinearKeyStore(file).get()).toBeUndefined()
    expect(JSON.parse(readFileSync(file, 'utf8')).key).toBeNull()
  })
})

describe('LinearTools', () => {
  it('lists only read-only tools', () => {
    expect(LINEAR_TOOL_DEFINITIONS.every((t) => isLinearToolName(t.name))).toBe(true)
  })

  it('refuses without a key', async () => {
    const { tools } = setup({}, null)
    const r = await tools.call('linear_whoami', {})
    expect(r.isError).toBe(true)
  })

  it('summarizes my issues and sends the key', async () => {
    const { tools, calls } = setup({
      viewer: {
        assignedIssues: {
          nodes: [
            {
              id: '1',
              identifier: 'ENG-1',
              title: 'Fix it',
              url: 'u',
              priorityLabel: 'High',
              dueDate: null,
              estimate: 2,
              updatedAt: 't',
              state: { name: 'Todo', type: 'unstarted' },
              labels: { nodes: [{ name: 'bug' }] },
            },
          ],
        },
      },
    })
    const r = parse(await tools.call('linear_my_issues', { limit: 999 }))
    expect(r[0]).toMatchObject({
      identifier: 'ENG-1',
      status: 'Todo',
      labels: ['bug'],
      estimate: 2,
    })
    expect(calls[0]!.headers.authorization).toBe('lin_api_test')
    expect(calls[0]!.body.variables.first).toBe(50)
  })

  it('builds filters for search and issue lookup', async () => {
    const { tools, calls } = setup({ issues: { nodes: [] } })
    await tools.call('linear_search_issues', { query: 'bug', team: 'ENG' })
    expect(calls[0]!.body.variables.filter).toEqual({
      title: { containsIgnoreCase: 'bug' },
      team: { key: { eqIgnoreCase: 'ENG' } },
      state: { type: { nin: ['completed', 'canceled'] } },
    })
    expect((await tools.call('linear_get_issue', { identifier: 'nope' })).isError).toBe(true)
    expect((await tools.call('linear_get_issue', { identifier: 'ENG-7' })).isError).toBe(true) // none found
    expect(calls[1]!.body.variables.filter).toEqual({
      team: { key: { eqIgnoreCase: 'ENG' } },
      number: { eq: 7 },
    })
  })
})
