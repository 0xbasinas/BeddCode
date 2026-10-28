import { describe, expect, it } from 'vitest'
import { browseItems } from './mentionItems.ts'

const entries = [
  { name: 'README.md', type: 'file' as const, size: 120 },
  { name: 'src', type: 'dir' as const },
  { name: 'node_modules', type: 'dir' as const, ignored: true },
  { name: 'docs', type: 'dir' as const },
  { name: 'app.ts', type: 'file' as const, size: 9 },
]

describe('browseItems', () => {
  it('lists folders first and leaves out ignored ones', () => {
    expect(browseItems('', entries).map((i) => i.path)).toEqual([
      'docs',
      'src',
      'app.ts',
      'README.md',
    ])
  })
  it('prefixes the folder and filters by name', () => {
    expect(browseItems('src/', entries, 'ap').map((i) => i.path)).toEqual(['src/app.ts'])
  })
})
