import { expect, it } from 'vitest'
import { readAttachmentDrafts } from './attachmentPersistence.ts'

it('restores references as unverified and interrupted transfers as actionable errors', () => {
  const key = JSON.stringify(['host', 'session'])
  const restored = readAttachmentDrafts(
    JSON.stringify({
      [key]: [
        { name: 'saved.txt', size: 3, id: 'saved', status: 'done' },
        { name: 'pending.txt', size: 2, status: 'uploading' },
      ],
      invalid: [],
    }),
  )
  expect(restored[key]).toMatchObject([
    { name: 'saved.txt', id: 'saved', status: 'checking' },
    {
      name: 'pending.txt',
      status: 'error',
      error: expect.stringContaining('select the file again'),
    },
  ])
  expect(() => readAttachmentDrafts('{')).toThrow()
})
