import { expect, it } from 'vitest'
import { sessionArchive, tarFiles } from './sessionArchive.ts'

function entries(tar: Uint8Array) {
  const decoder = new TextDecoder()
  const out = new Map<string, Uint8Array>()
  for (let offset = 0; tar[offset];) {
    const header = tar.slice(offset, offset + 512)
    const field = (start: number, end: number) =>
      decoder.decode(header.slice(start, end)).replace(/\0.*$/, '')
    const checksum = parseInt(field(148, 154), 8)
    header.fill(32, 148, 156)
    expect(header.reduce((a, b) => a + b, 0)).toBe(checksum)
    const length = parseInt(field(124, 136), 8)
    out.set(field(0, 100), tar.slice(offset + 512, offset + 512 + length))
    offset += 512 + Math.ceil(length / 512) * 512
  }
  return out
}

it('archives long transcripts and deduplicated bytes, reports missing files and sanitizes names', async () => {
  const calls: string[] = []
  const longText = 'A long message\n'.repeat(5000)
  const tar = await sessionArchive(
    {
      id: 's',
      title: 'Export',
      status: 'idle',
      items: [
        {
          kind: 'message',
          id: 'm',
          role: 'user',
          text: longText,
          attachments: [
            { name: '../../odd/../sample.bin', path: '/upload/a' },
            { name: 'duplicate.bin', path: '/upload/a' },
            { name: 'missing.txt', path: '/upload/b' },
          ],
        },
      ],
    },
    'Test host',
    async (path) => {
      calls.push(path)
      if (path.endsWith('/b')) throw new Error('Attachment is no longer available')
      return { size: 4, dataBase64: 'AAEC/w==' }
    },
  )
  const files = entries(tar)
  expect(calls).toEqual(['/upload/a', '/upload/b'])
  expect(files.get('attachments/001-sample.bin')).toEqual(new Uint8Array([0, 1, 2, 255]))
  expect(new TextDecoder().decode(files.get('transcript.md'))).toContain(longText)
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
  expect(manifest.attachments).toEqual([
    { name: '../../odd/../sample.bin', entry: 'attachments/001-sample.bin', included: true },
    { name: 'missing.txt', included: false, reason: 'Attachment is no longer available' },
  ])
  expect(manifest.coverage).toContain('not resumable')
})

it('reports invalid attachment lengths and refuses traversal archive entries', async () => {
  const tar = await sessionArchive(
    {
      id: 's',
      title: 'Export',
      status: 'idle',
      items: [
        {
          kind: 'message',
          id: 'm',
          role: 'user',
          text: '',
          attachments: [{ name: 'x', path: '/x' }],
        },
      ],
    },
    'Host',
    async () => ({ size: 2, dataBase64: 'AA==' }),
  )
  const manifest = JSON.parse(new TextDecoder().decode(entries(tar).get('manifest.json')))
  expect(manifest.attachments[0]).toMatchObject({
    included: false,
    reason: 'Attachment size did not match',
  })
  expect(() => tarFiles([{ name: '../escape', data: new Uint8Array() }])).toThrow('Invalid archive')
})
