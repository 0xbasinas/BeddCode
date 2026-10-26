import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findTranscript, readTranscript } from './transcriptFile.ts'

const line = (o: object) => JSON.stringify(o)

describe('transcript file', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-projects-'))
  mkdirSync(join(root, 'C--work'))
  const file = join(root, 'C--work', 'abc-1.jsonl')
  writeFileSync(
    file,
    [
      line({ type: 'user', uuid: 'u1', sessionId: 'abc-1', message: { content: 'first' } }),
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { id: 'm1', content: [{ type: 'text', text: 'one' }] },
      }),
      line({ type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: null }),
      line({
        type: 'user',
        uuid: 's',
        isCompactSummary: true,
        message: { content: 'summary of it' },
      }),
      line({ type: 'user', uuid: 'side', isSidechain: true, message: { content: 'subagent' } }),
      'not json',
      line({ type: 'user', uuid: 'u2', message: { content: 'second' } }),
    ].join('\n'),
  )

  it('finds a conversation by id under any folder, and nothing for odd ids', () => {
    expect(findTranscript('abc-1', root)).toBe(file)
    expect(findTranscript('nope', root)).toBeUndefined()
    expect(findTranscript('../abc-1', root)).toBeUndefined()
  })

  it('reads what came before a compaction, without the summary or side chains', async () => {
    const messages = await readTranscript(file)
    expect(messages.map((m) => m.uuid)).toEqual(['u1', 'a1', 'u2'])
  })
})
