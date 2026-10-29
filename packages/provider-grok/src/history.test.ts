import { describe, expect, it } from 'vitest'
import { createGrokHistory, parseExport, parseSessions } from './history.ts'

const LIST = [
  '',
  '(no label)',
  'SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY',
  '4742d025-8265-41e2-bb57-1fe5acc47e0b  2026-10-28  2026-10-28  local  List current directory file names',
  '59d0e228-32d6-444b-8a13-8504c903544a  2026-10-27  2026-10-27  local  (no summary)',
].join('\n')

describe('parseSessions', () => {
  it('reads the rows of `grok sessions list`', () => {
    expect(parseSessions(LIST)).toMatchObject([
      { id: '4742d025-8265-41e2-bb57-1fe5acc47e0b', title: 'List current directory file names' },
      { id: '59d0e228-32d6-444b-8a13-8504c903544a', title: 'Grok session' },
    ])
  })

  it('puts the most recently updated first', () => {
    const rows = parseSessions(LIST.split('\n').reverse().join('\n'))
    expect(rows[0]!.id).toBe('4742d025-8265-41e2-bb57-1fe5acc47e0b')
  })

  it('ignores anything that is not a row', () => {
    expect(parseSessions('No sessions found.')).toEqual([])
  })
})

describe('parseExport', () => {
  it('pairs user and assistant sections into exchanges', () => {
    const md = [
      '---',
      '## User',
      '',
      'Remember 417.',
      '',
      '## Assistant',
      '',
      'stored.',
      '',
      '## User',
      '',
      'What number?',
      '',
      '## Assistant',
      '',
      '417',
    ].join('\n')
    expect(parseExport(md)).toEqual([
      { user: 'Remember 417.', assistant: 'stored.' },
      { user: 'What number?', assistant: '417' },
    ])
  })

  it('keeps a last question that has no answer yet', () => {
    expect(parseExport('## User\n\nhello')).toEqual([{ user: 'hello', assistant: '' }])
  })
})

describe('createGrokHistory', () => {
  const ok = (stdout: string) => (async () => ({ code: 0, stdout, stderr: '' })) as never

  it('refuses an id that is not a plain session id', async () => {
    const h = createGrokHistory(() => 'grok', ok(''), {})
    await expect(h.read('--output=/etc/passwd')).rejects.toThrow(/Not a Grok session id/)
  })

  it('finds the title Grok gave a session', async () => {
    const h = createGrokHistory(() => 'grok', ok(LIST), {})
    expect(await h.title('4742d025-8265-41e2-bb57-1fe5acc47e0b')).toBe(
      'List current directory file names',
    )
    expect(await h.title('59d0e228-32d6-444b-8a13-8504c903544a')).toBeUndefined()
  })

  it('reports Grok’s own error when the command fails', async () => {
    const run = (async () => ({ code: 1, stdout: '', stderr: 'no such session\n' })) as never
    await expect(createGrokHistory(() => 'grok', run, {}).read('abcdefgh-1')).rejects.toThrow(
      'no such session',
    )
  })
})
