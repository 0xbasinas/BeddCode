import { expect, it } from 'vitest'
import { exportSession } from './exportSession.ts'
import { appendReplyQuote } from './quote.ts'

it('exports all loaded events, masks secret answers and discloses omitted attachments', () => {
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
  expect(text).toContain('"attachmentBytesIncluded": false')
  expect(text).toContain('[Secret answer omitted]')
  expect(text).not.toContain('do-not-export')
  expect(text).not.toContain('/private/image.png')
  expect(text).toContain('````\n```\nfailed\n```\n````')
  expect(text).toContain('Disconnected')
})

it('quotes multiline selections without replacing a draft or allowing Markdown to escape', () => {
  expect(appendReplyQuote('My draft', 'First\n\n# Heading', 2)).toBe(
    "My draft\n\nRegarding the agent's reply in turn 2:\n> First\n> \n> # Heading\n\n",
  )
})
