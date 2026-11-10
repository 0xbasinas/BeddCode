import { expect, it } from 'vitest'
import { exportSession } from './exportSession'

it('exports loaded events, masks secret answers and discloses omitted attachments', () => {
  const text = exportSession(
    {
      id: 's',
      title: 'Example',
      status: 'needs-you',
      items: [
        {
          kind: 'message',
          id: 'm',
          role: 'user',
          text: 'Hello',
          attachments: [{ name: 'image.png', path: '/private/image.png' }],
        },
        {
          kind: 'question',
          id: 'q',
          requestId: 'r',
          questions: [{ id: 'secret', question: 'Password?', secret: true }],
          answers: { secret: ['do-not-export'] },
        },
        {
          kind: 'tool',
          id: 't',
          toolKind: 'command',
          title: 'Test',
          status: 'failed',
          output: '```\nfailed\n```',
        },
        { kind: 'error', id: 'e', message: 'Disconnected' },
      ],
    },
    'Remote',
    new Date('2026-11-01T12:00:00Z'),
  )
  expect(text).toContain('"exportedAt": "2026-11-01T12:00:00.000Z"')
  expect(text).toContain('Hello')
  expect(text).toContain('image.png')
  expect(text).not.toContain('/private/image.png')
  expect(text).toContain('[Secret answer omitted]')
  expect(text).not.toContain('do-not-export')
  expect(text).toContain('Disconnected')
})
