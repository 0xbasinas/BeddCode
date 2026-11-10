import { describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '@beddcode/contracts'

vi.mock('@/host/store', () => ({ hostRequest: vi.fn() }))

import { browseItems } from './mentionItems'

const entries: FileEntry[] = [
  { name: 'src', type: 'dir' },
  { name: 'README.md', type: 'file', size: 12 },
  { name: 'node_modules', type: 'dir', ignored: true },
  { name: 'app.tsx', type: 'file' },
]

describe('browseItems', () => {
  it('lists folders first and hides ignored entries', () => {
    expect(browseItems('', entries).map((i) => i.name)).toEqual(['src', 'app.tsx', 'README.md'])
  })

  it('filters by name and prefers a prefix match', () => {
    expect(browseItems('', entries, 'app').map((i) => i.name)).toEqual(['app.tsx'])
  })
})
