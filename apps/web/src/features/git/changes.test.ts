import { describe, expect, it } from 'vitest'
import type { GitFile } from '@beddcode/contracts'
import { commitLabel, defaultSelected, groupByDirectory, selectedPaths } from './changes.ts'

const file = (path: string, status: GitFile['status'] = 'M', staged = false): GitFile => ({
  path,
  status,
  staged,
  added: 1,
  removed: 0,
})

describe('groupByDirectory', () => {
  it('groups by folder with names, in path order', () => {
    const groups = groupByDirectory([
      file('test/limiter/failover.test.ts', 'A'),
      file('src/limiter/redis-store.ts'),
      file('README.md'),
      file('src/limiter/token-bucket.ts'),
    ])
    expect(groups.map((g) => g.dir)).toEqual(['', 'src/limiter', 'test/limiter'])
    const src = groups.find((g) => g.dir === 'src/limiter')!
    expect(src.files.map((f) => f.name)).toEqual(['redis-store.ts', 'token-bucket.ts'])
    expect(groups.find((g) => g.dir === '')!.files[0]?.name).toBe('README.md')
  })
})

describe('selection', () => {
  it('starts with tracked changes checked and new files unchecked', () => {
    expect(defaultSelected(file('a.ts', 'M'))).toBe(true)
    expect(defaultSelected(file('b.ts', 'D'))).toBe(true)
    expect(defaultSelected(file('new.ts', 'A'))).toBe(false)
    expect(defaultSelected(file('new.ts', 'A', true))).toBe(true)
  })

  it("applies the user's choices over the defaults", () => {
    const files = [file('a.ts'), file('b.ts'), file('new.ts', 'A')]
    expect(selectedPaths(files, {})).toEqual(['a.ts', 'b.ts'])
    expect(selectedPaths(files, { 'a.ts': false, 'new.ts': true })).toEqual(['b.ts', 'new.ts'])
  })

  it('labels the commit button', () => {
    expect(commitLabel(1)).toBe('Commit 1 file')
    expect(commitLabel(3)).toBe('Commit 3 files')
  })
})
