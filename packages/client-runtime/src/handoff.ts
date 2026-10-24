import type { SessionView } from './replica.ts'

const compact = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * A message that lets another agent pick up a session's work: where it happens, what was asked
 * and answered, which commands ran and which files changed. Each piece is shortened and the oldest
 * are dropped first, so the result stays within `maxChars` and the latest context survives.
 */
export function handoffPrompt(
  view: SessionView,
  options: { agentLabel?: string; maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? 6_000
  const where = [
    view.projectless ? undefined : `Folder: ${view.cwd}`,
    view.branch ? `Branch: ${view.branch}` : undefined,
  ].filter(Boolean)
  const head = [
    `I am continuing work that was started with ${options.agentLabel ?? 'another agent'} in "${view.title}".`,
    ...where,
    'Here is what happened so far (oldest first):',
  ].join('\n')

  const lines: string[] = []
  const changed = new Set<string>()
  for (const item of view.items) {
    switch (item.kind) {
      case 'message':
        if (item.text.trim()) {
          lines.push(
            item.role === 'user'
              ? `- I asked: ${compact(item.text, 240)}`
              : `- The agent said: ${compact(item.text, 400)}`,
          )
        }
        break
      case 'tool':
        if (item.toolKind === 'command') lines.push(`- Ran: ${compact(item.title, 160)}`)
        for (const p of item.toolKind === 'edit' ? (item.paths ?? []) : []) changed.add(p)
        break
      case 'diff':
        changed.add(item.path)
        break
      case 'changes':
        if (item.reverted) lines.push('- I undid the changes of that turn.')
        else for (const f of item.files) changed.add(f.path)
        break
      case 'error':
        lines.push(`- Error: ${compact(item.message, 200)}`)
        break
      default:
        break
    }
  }

  const tail: string[] = []
  if (view.plan?.steps.length) {
    tail.push(
      'The plan as it stood:',
      ...view.plan.steps.map((s) => `- [${s.status}] ${compact(s.text, 160)}`),
    )
  }
  if (changed.size > 0) {
    const files = [...changed]
    tail.push(
      `Files changed so far: ${files.slice(0, 30).join(', ')}${files.length > 30 ? ` and ${files.length - 30} more` : ''}`,
    )
  }
  tail.push('Look at the current state of the files before changing anything. Next:')

  const fixed = head.length + tail.join('\n').length + 4
  const kept: string[] = []
  let used = fixed
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (used + line.length + 1 > maxChars) {
      kept.unshift('- (earlier messages left out)')
      break
    }
    kept.unshift(line)
    used += line.length + 1
  }
  return [head, ...kept, '', ...tail, ''].join('\n')
}
