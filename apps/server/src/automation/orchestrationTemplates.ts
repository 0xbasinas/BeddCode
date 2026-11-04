import { OrchestrationTemplate, type OrchestrationTemplateWorker } from '@beddcode/contracts'

export type TemplateWorkerSpec = OrchestrationTemplateWorker & {
  role: 'planner' | 'implementer' | 'reviewer' | 'worker' | 'tester'
  task: string
}

/** Expand launch inputs into role assignments; user tasks are never saved in settings. */
export function expandTemplate(
  value: OrchestrationTemplate,
  tasks: string[],
): TemplateWorkerSpec[] {
  const template = OrchestrationTemplate.parse(value)
  if (tasks.some((task) => typeof task !== 'string' || !task.trim() || task.length > 16000))
    throw new Error('Each task must contain 1 to 16000 characters')
  if (template.kind === 'plan-implement-review') {
    if (tasks.length !== 1) throw new Error('This template requires one task')
    return [
      { ...template.planner, role: 'planner', task: tasks[0]! },
      { ...template.implementer, role: 'implementer', task: tasks[0]! },
      { ...template.reviewer, role: 'reviewer', task: tasks[0]! },
    ]
  }
  if (tasks.length !== template.workers.length) throw new Error('Provide one task for each worker')
  return [
    ...template.workers.map((worker, index) => ({
      ...worker,
      role: 'worker' as const,
      task: tasks[index]!,
    })),
    { ...template.tester, role: 'tester', task: tasks.join('\n\n') },
  ]
}
