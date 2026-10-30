import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentStore, MAX_ATTACHMENT_BYTES, safeFileName } from './store.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-att-'))
  dirs.push(d)
  return d
}

describe('safeFileName', () => {
  it('keeps the base name and replaces awkward characters', () => {
    expect(safeFileName('C:\\Users\\me\\ingest.log')).toBe('ingest.log')
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('my file (1).png')).toBe('my file (1).png')
    expect(safeFileName('a;rm -rf *.txt')).toBe('a_rm -rf _.txt')
    expect(safeFileName('...')).toBe('file')
    expect(safeFileName('')).toBe('file')
  })
})

describe('AttachmentStore', () => {
  it('saves each upload in its own directory and returns its path', async () => {
    const store = new AttachmentStore(tmp())
    const [a, b] = await Promise.all([
      store.save('notes.txt', Buffer.from('one')),
      store.save('notes.txt', Buffer.from('two')),
    ])
    expect(a.path).not.toBe(b.path)
    expect(path.basename(a.path)).toBe('notes.txt')
    expect(readFileSync(a.path, 'utf8')).toBe('one')
    expect(store.get(b.id)).toMatchObject({ name: 'notes.txt', size: 3 })
    expect(store.get('missing')).toBeUndefined()
  })

  it('rejects files over the size limit', async () => {
    const store = new AttachmentStore(tmp())
    await expect(store.save('big.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).rejects.toThrow(
      'larger',
    )
  })

  it('locates stored files by id or path, and nothing outside the store', async () => {
    const root = tmp()
    const store = new AttachmentStore(root)
    const saved = await store.save('shot.png', Buffer.from('x'))
    expect(store.locate({ id: saved.id })).toBe(saved.path)
    expect(store.locate({ path: saved.path })).toBe(saved.path)
    expect(store.locate({ path: path.join(root, '..', 'other.png') })).toBeUndefined()
    expect(store.locate({ path: root })).toBeUndefined()
    expect(store.locate({ id: 'missing' })).toBeUndefined()
    expect(store.locate({})).toBeUndefined()
  })
})
