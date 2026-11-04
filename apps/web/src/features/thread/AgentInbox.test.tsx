import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionView } from '@beddcode/client-runtime'
import { AgentInbox } from './AgentInbox.tsx'

vi.mock('../../stores/host.ts', () => ({
  useHostStore: (selector: (state: unknown) => unknown) => selector({ runtimes: {} }),
}))

it('offers the session inbox and counts its real message threads', () => {
  const session = {
    id: 'a',
    projectPath: '/work',
    items: [
      {
        kind: 'agent-message',
        id: '1',
        messageId: 'm1',
        threadId: 't',
        senderId: 'a',
        recipientId: 'b',
        text: 'Question',
      },
      {
        kind: 'agent-message',
        id: '2',
        messageId: 'm2',
        threadId: 't',
        senderId: 'b',
        recipientId: 'a',
        text: 'Reply',
      },
    ],
  } as SessionView
  const html = renderToStaticMarkup(<AgentInbox session={session} hostKey="host" />)
  expect(html).toContain('Agent inbox · 1 thread')
  expect(html).toContain('aria-expanded="false"')
})
