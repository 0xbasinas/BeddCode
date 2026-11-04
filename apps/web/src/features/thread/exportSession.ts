import type { SessionView, TranscriptItem } from '@beddcode/client-runtime'

// A fence longer than any run in the content keeps tool output from breaking the export.
function fenced(text: string): string {
  let longest = 2
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}

function itemText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'message':
      return `### ${item.role === 'user' ? 'You' : 'Agent'}${item.turnNo ? ` · turn ${item.turnNo}` : ''}\n\n${item.text}${item.attachments?.length ? '\n\nAttachments (bytes not included):\n' + item.attachments.map((a) => `- ${a.name}`).join('\n') : ''}`
    case 'tool':
      return `### Tool · ${item.status}\n\n${item.title}${item.input ? '\n\nInput:\n' + fenced(item.input) : ''}${item.output ? '\n\nOutput:\n' + fenced(item.output) : ''}`
    case 'approval':
      return `### Approval · ${item.cancelled ? 'cancelled' : item.resolvedOptionId ? (item.options.find((o) => o.id === item.resolvedOptionId)?.label ?? item.resolvedOptionId) : 'pending'}\n\n${item.title}${item.detail ? '\n\n' + item.detail : ''}${item.plan ? '\n\n' + item.plan : ''}`
    case 'question':
      return `### Question · ${item.dismissed ? 'dismissed' : item.answers ? 'answered' : 'pending'}\n\n${item.questions.map((q) => `${q.question}\n\n${q.secret ? '[Secret answer omitted]' : (item.answers?.[q.id]?.join(', ') ?? '[Unanswered]')}`).join('\n\n')}`
    case 'changes':
      return `### Folder changes${item.reverted ? ' · undone' : ''}\n\n${item.files.map((f) => `- ${f.status} ${f.path} (+${f.added}, -${f.removed})`).join('\n')}${item.truncated ? '\n\nFile list is incomplete.' : ''}\n\nSnapshot file contents are not included.`
    case 'diff':
      return `### Diff · ${item.path}\n\n${fenced(item.patch)}`
    case 'compaction':
      return `### Context compaction · ${item.state}`
    case 'error':
      return `### Error\n\n${item.message}`
    case 'notice':
      return `### Notice\n\n${item.message}`
    case 'agent-message':
      return `### Agent message · ${item.senderId} → ${item.recipientId} · thread ${item.threadId}\n\n${item.text}`
  }
}

/** Portable, human-readable snapshot of the loaded transcript, with an explicit coverage manifest. */
export function exportSession(
  session: Pick<SessionView, 'id' | 'title' | 'status' | 'items'>,
  host: string,
  now = new Date(),
) {
  const manifest = {
    format: 'beddcode-session-export',
    version: 1,
    sessionId: session.id,
    host,
    exportedAt: now.toISOString(),
    status: session.status,
    coverage: 'Loaded transcript snapshot; not a resumable agent session',
    attachmentBytesIncluded: false,
    attachments: session.items.flatMap((item) =>
      item.kind === 'message'
        ? (item.attachments ?? []).map((a) => ({ name: a.name, included: false }))
        : [],
    ),
    secretQuestionAnswersIncluded: false,
  }
  return `# ${session.title || 'Session'}\n\n${fenced(JSON.stringify(manifest, null, 2))}\n\nMessages and tool output may contain personal information. Attachment bytes and snapshot file contents are omitted.\n\n${session.items.map(itemText).join('\n\n---\n\n')}\n`
}

export function downloadSession(session: SessionView, host: string) {
  const url = URL.createObjectURL(
    new Blob([exportSession(session, host)], { type: 'text/markdown;charset=utf-8' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${session.title.replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 80) || 'session'}.md`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
