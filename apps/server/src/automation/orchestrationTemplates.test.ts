import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationTemplate } from '@beddcode/contracts'
import { OrchestrationSettingsService } from './orchestrationSettings.ts'
import { expandTemplate } from './orchestrationTemplates.ts'

describe('orchestration templates', () => {
  it('validates worker budgets and rejects unknown fields', () => {
    const base = {
      id: 'mine',
      name: 'Mine',
      kind: 'plan-implement-review',
      planner: { agent: 'codex' },
      implementer: { agent: 'claude' },
      reviewer: { agent: 'pi', turnCap: 2, timeBudgetSeconds: 60 },
    }
    expect(OrchestrationTemplate.safeParse(base).success).toBe(true)
    expect(
      OrchestrationTemplate.safeParse({ ...base, planner: { agent: 'codex', turnCap: 0 } }).success,
    ).toBe(false)
    expect(OrchestrationTemplate.safeParse({ ...base, secret: 'x' }).success).toBe(false)
    expect(
      expandTemplate(OrchestrationTemplate.parse(base), ['Fix it']).map((w) => w.role),
    ).toEqual(['planner', 'implementer', 'reviewer'])
  })
  it('persists user templates and expands one task per worker', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'templates-'))
    try {
      const file = path.join(dir, 'settings.json')
      const service = new OrchestrationSettingsService(file)
      const template = OrchestrationTemplate.parse({
        id: 'mine',
        name: 'Mine',
        kind: 'parallel-fix-and-test',
        workers: [{ agent: 'codex' }, { agent: 'grok', model: 'm' }],
        tester: { agent: 'pi' },
      })
      service.saveTemplate(template)
      expect(new OrchestrationSettingsService(file).listTemplates()).toContainEqual(template)
      expect(expandTemplate(template, ['one', 'two']).map((w) => [w.role, w.task])).toEqual([
        ['worker', 'one'],
        ['worker', 'two'],
        ['tester', 'one\n\ntwo'],
      ])
      expect(() => expandTemplate(template, ['one'])).toThrow()
      expect(() => service.deleteTemplate('parallel-fix-and-test')).toThrow()
      service.deleteTemplate('mine')
      expect(service.listTemplates()).not.toContainEqual(template)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
