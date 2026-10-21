import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store talks to the host through one function; replace it with a scripted fake.
const files: Record<string, { content: string; mtime: number }> = {}
const lists: Record<string, { name: string; type: 'file' | 'dir' }[]> = {}
let writeError: Error | null = null
let writePending: Promise<void> | undefined
const calls: string[] = []

vi.mock('../../stores/host.ts', () => ({
  hostRequest: async (_host: string, method: string, params: Record<string, unknown>) => {
    calls.push(`${method}:${String(params.dir ?? params.path ?? '')}`)
    switch (method) {
      case 'files.list':
        return { entries: lists[String(params.dir ?? '')] ?? [] }
      case 'files.read': {
        const f = files[String(params.path)]
        if (!f) throw new Error(`Not a file: ${String(params.path)}`)
        return {
          path: params.path,
          content: f.content,
          mtime: f.mtime,
          size: f.content.length,
          binary: false,
          tooLarge: false,
        }
      }
      case 'files.write': {
        if (writeError) throw writeError
        await writePending
        files[String(params.path)] = { content: String(params.content), mtime: 999 }
        return { mtime: 999 }
      }
      case 'files.create':
        files[String(params.path)] = { content: '', mtime: 1 }
        return {}
    }
    throw new Error(`unexpected ${method}`)
  },
}))

const { useFiles } = await import('./filesStore.ts')
const state = () => useFiles.getState().byCwd['/w']!

beforeEach(() => {
  useFiles.setState({ byCwd: {} })
  calls.length = 0
  writeError = null
  writePending = undefined
  for (const k of Object.keys(files)) delete files[k]
  for (const k of Object.keys(lists)) delete lists[k]
  files['a.ts'] = { content: 'A', mtime: 10 }
  files['src/b.ts'] = { content: 'B', mtime: 20 }
  lists[''] = [
    { name: 'src', type: 'dir' },
    { name: 'a.ts', type: 'file' },
  ]
  lists['src'] = [{ name: 'b.ts', type: 'file' }]
})

describe('files store', () => {
  it('loads folders lazily when they are expanded and caches the listing', async () => {
    await useFiles.getState().loadDir('/w', '')
    expect(state().entries['']?.map((e) => e.name)).toEqual(['src', 'a.ts'])
    await useFiles.getState().toggleDir('/w', 'src')
    expect(state().expanded.src).toBe(true)
    expect(state().entries.src?.[0]?.name).toBe('b.ts')

    await useFiles.getState().toggleDir('/w', 'src') // collapse
    await useFiles.getState().toggleDir('/w', 'src') // expand again: no second request
    expect(calls.filter((c) => c === 'files.list:src')).toHaveLength(1)
    useFiles.getState().collapseAll('/w')
    expect(state().expanded).toEqual({})
  })

  it('opens files in tabs, activates an already open one, and closes to a neighbour', async () => {
    const f = useFiles.getState()
    await f.open('/w', 'a.ts')
    await f.open('/w', 'src/b.ts')
    expect(state().tabs).toEqual(['a.ts', 'src/b.ts'])
    expect(state().active).toBe('src/b.ts')
    expect(state().docs['a.ts']).toMatchObject({ content: 'A', mtime: 10, dirty: false })

    await f.open('/w', 'a.ts')
    expect(state().active).toBe('a.ts')
    expect(calls.filter((c) => c === 'files.read:a.ts')).toHaveLength(1)

    f.close('/w', 'a.ts')
    expect(state().tabs).toEqual(['src/b.ts'])
    expect(state().active).toBe('src/b.ts')
    f.close('/w', 'src/b.ts')
    expect(state().active).toBeUndefined()
  })

  it('keeps a tab with the error when a file cannot be read', async () => {
    await useFiles.getState().open('/w', 'missing.ts')
    expect(state().docs['missing.ts']?.error).toContain('Not a file')
    expect(state().active).toBe('missing.ts')
  })

  it('saves with the opened mtime and clears the dirty flag', async () => {
    const f = useFiles.getState()
    await f.open('/w', 'a.ts')
    f.setDirty('/w', 'a.ts', true)
    await f.save('/w', 'a.ts', 'A2')
    expect(state().docs['a.ts']).toMatchObject({
      content: 'A2',
      mtime: 999,
      dirty: false,
      conflict: false,
    })
  })

  it('retains unsaved text across tab changes and clears it on undo or reload', async () => {
    const f = useFiles.getState()
    await f.open('/w', 'a.ts')
    f.setDraft('/w', 'a.ts', 'draft')
    await f.open('/w', 'src/b.ts')
    await f.open('/w', 'a.ts')
    expect(state().docs['a.ts']).toMatchObject({ content: 'A', draft: 'draft', dirty: true })
    f.setDraft('/w', 'a.ts', 'A')
    expect(state().docs['a.ts']).toMatchObject({ draft: undefined, dirty: false })
    f.setDraft('/w', 'a.ts', 'another draft')
    await f.reload('/w', 'a.ts')
    expect(state().docs['a.ts']).toMatchObject({
      content: 'A',
      draft: undefined,
      dirty: false,
      version: 1,
    })
  })

  it('keeps edits made while a save is pending, including undo back to the old disk text', async () => {
    const f = useFiles.getState()
    await f.open('/w', 'a.ts')
    for (const next of ['newer draft', 'é']) {
      f.setDraft('/w', 'a.ts', 'submitted')
      let finish!: () => void
      writePending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const saving = f.save('/w', 'a.ts', 'submitted')
      f.setDraft('/w', 'a.ts', next)
      finish()
      await saving
      expect(state().docs['a.ts']).toMatchObject({ content: 'submitted', draft: next, dirty: true })
      writePending = undefined
      await f.save('/w', 'a.ts', next)
      expect(state().docs['a.ts']).toMatchObject({
        content: next,
        draft: undefined,
        dirty: false,
        size: new TextEncoder().encode(next).length,
      })
    }
  })

  it('preserves undo to the old disk text while saving a different draft', async () => {
    const f = useFiles.getState()
    await f.open('/w', 'a.ts')
    f.setDraft('/w', 'a.ts', 'submitted')
    let finish!: () => void
    writePending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const saving = f.save('/w', 'a.ts', 'submitted')
    f.setDraft('/w', 'a.ts', 'A')
    finish()
    await saving
    expect(state().docs['a.ts']).toMatchObject({ content: 'submitted', draft: 'A', dirty: true })
  })

  it('flags a conflict when the file changed on disk, and can then overwrite', async () => {
    const f = useFiles.getState()
    await f.open('/w', 'a.ts')
    writeError = new Error('The file changed on disk since you opened it')
    await expect(f.save('/w', 'a.ts', 'mine')).rejects.toThrow('changed on disk')
    expect(state().docs['a.ts']?.conflict).toBe(true)

    writeError = null
    await f.save('/w', 'a.ts', 'mine', true)
    expect(state().docs['a.ts']).toMatchObject({ conflict: false, content: 'mine' })
  })

  it('reloads open files that changed on disk, but only flags the ones with unsaved edits', async () => {
    const f = useFiles.getState()
    await f.open('/w', 'a.ts')
    await f.open('/w', 'src/b.ts')
    f.setDirty('/w', 'src/b.ts', true)
    files['a.ts'] = { content: 'A-new', mtime: 50 }
    files['src/b.ts'] = { content: 'B-new', mtime: 60 }

    f.changed('/w', ['a.ts', 'src/b.ts'])
    await new Promise((r) => setTimeout(r, 20))
    expect(state().docs['a.ts']).toMatchObject({
      content: 'A-new',
      mtime: 50,
      version: 1,
      dirty: false,
    })
    expect(state().docs['src/b.ts']).toMatchObject({ content: 'B', conflict: true, version: 0 })
  })

  it('refreshes the listing of a loaded parent folder when something inside it changes', async () => {
    const f = useFiles.getState()
    await f.loadDir('/w', '')
    await f.toggleDir('/w', 'src')
    lists.src = [
      { name: 'b.ts', type: 'file' },
      { name: 'new.ts', type: 'file' },
    ]
    calls.length = 0
    f.changed('/w', ['src/new.ts'])
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual(['files.list:src'])
    expect(state().entries.src?.map((e) => e.name)).toEqual(['b.ts', 'new.ts'])

    // Changes in folders we never listed cost nothing.
    calls.length = 0
    f.changed('/w', ['other/deep/file.ts'])
    expect(calls).toEqual([])
  })

  it('creates a file, expands the folders on its path and opens it', async () => {
    const f = useFiles.getState()
    lists['docs'] = [{ name: 'guide.md', type: 'file' }]
    files['docs/guide.md'] = { content: '', mtime: 1 }
    await f.create('/w', 'docs/guide.md', 'file')
    expect(state().expanded.docs).toBe(true)
    expect(state().tabs).toEqual(['docs/guide.md'])
    expect(state().entries.docs?.[0]?.name).toBe('guide.md')
  })
})
