import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  OrchestrationSettings,
  OrchestrationApproval,
  OrchestrationTemplate,
  type OrchestrationLimits,
} from '@beddcode/contracts'
import { writeFileAtomic } from '@beddcode/shared'

const defaults: OrchestrationLimits = {
  maxDepth: 2,
  maxWorkers: 5,
  maxTotalWorkers: 10,
  maxMessagesPerMinute: 10,
  maxMessages: 50,
  approval: 'off',
}
const builtInTemplates: OrchestrationTemplate[] = [
  {
    id: 'plan-implement-review',
    name: 'Plan, implement, review',
    kind: 'plan-implement-review',
    planner: { agent: 'codex' },
    implementer: { agent: 'codex' },
    reviewer: { agent: 'codex' },
  },
  {
    id: 'parallel-fix-and-test',
    name: 'Parallel fix and test',
    kind: 'parallel-fix-and-test',
    workers: [{ agent: 'codex' }],
    tester: { agent: 'codex' },
  },
]
const expiryMs = 240_000

/** Host-owned configuration and decisions, persisted before a waiting tool is released. */
export class OrchestrationSettingsService {
  private settings: OrchestrationSettings = { global: { ...defaults }, projects: {} }
  private templates: OrchestrationTemplate[] = []
  private approvals: OrchestrationApproval[] = []
  private waiters = new Map<string, (status: OrchestrationApproval['status']) => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private file: string) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      this.settings = OrchestrationSettings.parse(data.settings)
      this.approvals = OrchestrationApproval.array().parse(data.approvals)
      this.templates = OrchestrationTemplate.array().parse(data.templates ?? [])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const item of this.approvals) if (item.status === 'pending') this.arm(item)
  }
  private save() {
    writeFileAtomic(
      this.file,
      JSON.stringify({
        settings: this.settings,
        approvals: this.approvals,
        templates: this.templates,
      }),
      { mode: 0o600 },
    )
  }
  get() {
    return structuredClone(this.settings)
  }
  set(settings: OrchestrationSettings) {
    this.settings = OrchestrationSettings.parse(settings)
    this.save()
    return this.get()
  }
  listTemplates() {
    return structuredClone([...builtInTemplates, ...this.templates])
  }
  saveTemplate(value: OrchestrationTemplate) {
    const template = OrchestrationTemplate.parse(value)
    if (builtInTemplates.some((item) => item.id === template.id))
      throw new Error('Built-in templates cannot be replaced')
    this.templates = [...this.templates.filter((item) => item.id !== template.id), template]
    this.save()
    return structuredClone(template)
  }
  deleteTemplate(id: string) {
    if (builtInTemplates.some((item) => item.id === id))
      throw new Error('Built-in templates cannot be deleted')
    if (!this.templates.some((item) => item.id === id)) throw new Error('Template not found')
    this.templates = this.templates.filter((item) => item.id !== id)
    this.save()
  }
  forProject(project?: string): OrchestrationLimits {
    return { ...this.settings.global, ...(project ? this.settings.projects[project] : {}) }
  }
  list() {
    for (const item of this.approvals)
      if (item.status === 'pending' && item.expiresAt <= Date.now())
        this.resolve(item.id, 'expired')
    return structuredClone(this.approvals)
  }
  private arm(item: OrchestrationApproval) {
    const timer = setTimeout(
      () => this.resolve(item.id, 'expired'),
      Math.max(0, item.expiresAt - Date.now()),
    )
    timer.unref()
    this.timers.set(item.id, timer)
  }
  resolve(id: string, status: 'approved' | 'denied' | 'expired') {
    const item = this.approvals.find((entry) => entry.id === id)
    if (!item || item.status !== 'pending') throw new Error('Pending approval not found')
    if (item.expiresAt <= Date.now()) status = 'expired'
    item.status = status
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.save()
    this.waiters.get(id)?.(status)
    this.waiters.delete(id)
    return structuredClone(item)
  }
  async request(
    sessionId: string,
    project: string | undefined,
    kind: 'spawn' | 'message',
    details: string,
  ) {
    const mode = this.forProject(project).approval
    if (mode === 'off' || (kind === 'message' && mode !== 'approve-spawns-and-messages')) return
    const now = Date.now()
    const item: OrchestrationApproval = {
      id: randomUUID(),
      sessionId,
      project,
      kind,
      details,
      status: 'pending',
      createdAt: now,
      expiresAt: now + expiryMs,
    }
    this.approvals.push(item)
    this.save()
    this.arm(item)
    const status = await new Promise<OrchestrationApproval['status']>((resolve) =>
      this.waiters.set(item.id, resolve),
    )
    if (status !== 'approved') throw new Error(`Orchestration ${kind} ${status}`)
  }
  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
