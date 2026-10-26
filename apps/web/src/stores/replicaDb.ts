/**
 * Where this window keeps its copy of each host's history, so the next start shows it at once
 * instead of fetching it all again. IndexedDB, because the copy can be several megabytes.
 */
const DB = 'beddcode-replica'
const STORE = 'replicas'

let opened: Promise<IDBDatabase> | undefined
const open = (): Promise<IDBDatabase> =>
  (opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))

const run = async <T>(mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>) => {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const request = act(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readReplica(key: string): Promise<string | null> {
  try {
    const raw = await run<unknown>('readonly', (s) => s.get(key))
    return typeof raw === 'string' ? raw : null
  } catch {
    return null
  }
}

/** Saves the copy, or removes it when given null. A failure just means the next start is slower. */
export async function writeReplica(key: string, raw: string | null): Promise<void> {
  try {
    if (raw === null) await run('readwrite', (s) => s.delete(key))
    else await run('readwrite', (s) => s.put(raw, key))
  } catch {
    // Private windows and full disks: carry on without a saved copy.
  }
}
