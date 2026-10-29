import { describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { EventStore, StorageError, storageError } from './eventStore.ts'

const message = (sessionId: string, text: string) => ({
  type: 'message.delta' as const,
  sessionId,
  at: Date.now(),
  turnId: 't1',
  role: 'assistant' as const,
  text,
})

/** The store's own connection, to make its disk "full" the way SQLite reports it. */
const limitPages = (store: EventStore, pages: number) =>
  (store as unknown as { db: DatabaseSync }).db.exec(`PRAGMA max_page_count = ${pages}`)

describe('EventStore storage errors', () => {
  it('says the disk is full instead of "database or disk is full", and works again once there is room', () => {
    const store = new EventStore(':memory:')
    const { page_count } = (store as unknown as { db: DatabaseSync }).db
      .prepare('PRAGMA page_count')
      .get() as { page_count: number }
    limitPages(store, page_count)
    const big = 'x'.repeat(64 * 1024)
    expect(() => store.append(message('s1', big))).toThrow(StorageError)
    expect(() => store.append(message('s1', big))).toThrow(/disk BeddCode saves to is full/)
    // A batch fails as a whole, with the same reason rather than "no transaction is active".
    expect(() => store.appendMany([message('s1', 'a'), message('s1', big)])).toThrow(
      /disk BeddCode saves to is full/,
    )
    expect(store.readSession('s1')).toHaveLength(0)

    limitPages(store, 1_000_000)
    expect(store.append(message('s1', big)).seq).toBeGreaterThan(0)
    store.close()
  })

  it('explains busy, read-only and disk errors by their SQLite code, and leaves others alone', () => {
    const at = (errcode: number) =>
      storageError(Object.assign(new Error('x'), { errcode }), '/d/beddcode.db')
    expect(at(5)).toMatchObject({
      reason: 'busy',
      message: expect.stringMatching(/another BeddCode host using \/d/),
    })
    expect(at(6)).toMatchObject({ reason: 'busy' })
    expect(at(8 | (1 << 8))).toMatchObject({ reason: 'read-only' })
    expect(at(10 | (3 << 8))).toMatchObject({ reason: 'io' })
    const other = new Error('constraint')
    expect(storageError(Object.assign(other, { errcode: 19 }), 'f')).toBe(other)
    expect(storageError('plain', 'f')).toBe('plain')
  })

  it('opens a database a newer version wrote, and says so', () => {
    const file = `${process.env.TMPDIR ?? '/tmp'}/beddcode-newer-${process.pid}-${Date.now()}.db`
    new EventStore(file).close()
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA user_version = 999')
    raw.close()
    const warnings: string[] = []
    const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} }
    const store = new EventStore(file, log)
    expect(warnings.join('\n')).toMatch(/newer BeddCode/)
    store.close()
    for (const end of ['', '-wal', '-shm']) rmSync(file + end, { force: true })
  })
})
