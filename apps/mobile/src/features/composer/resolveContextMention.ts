import { hostRequest } from '@/host/store'

import {
  formatCiMention,
  formatDiffMention,
  formatPrMention,
  formatTermMention,
  type ContextMentionId,
} from './contextMentions'

/** Live text for a special @mention, fetched from the host. */
export async function resolveContextMention(
  hostKey: string,
  cwd: string,
  id: ContextMentionId,
): Promise<string> {
  switch (id) {
    case 'diff':
      return formatDiffMention(await hostRequest(hostKey, 'git.status', { cwd }))
    case 'ci':
      return formatCiMention(await hostRequest(hostKey, 'git.ci.report', { cwd }))
    case 'pr':
      return formatPrMention(await hostRequest(hostKey, 'git.pr.get', { cwd }))
    case 'term':
      return formatTermMention(await hostRequest(hostKey, 'terminals.tail', { cwd, maxChars: 8000 }))
  }
}
