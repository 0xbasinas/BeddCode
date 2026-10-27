import { File, Paths } from 'expo-file-system'

/**
 * Where the phone keeps its copy of each host's history, so opening the app shows it at once
 * instead of fetching everything again. A file per host: the copy can be several megabytes,
 * more than the key-value stores take.
 */
const file = (key: string) =>
  new File(Paths.document, `replica-${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

export async function readReplica(key: string): Promise<string | null> {
  try {
    const f = file(key)
    return f.exists ? await f.text() : null
  } catch {
    return null
  }
}

/** Saves the copy, or removes it when given null. A failure just means the next start is slower. */
export async function writeReplica(key: string, raw: string | null): Promise<void> {
  try {
    const f = file(key)
    if (raw === null) {
      if (f.exists) f.delete()
      return
    }
    if (!f.exists) f.create()
    await f.write(raw)
  } catch {
    // Storage full or unavailable: carry on without a saved copy.
  }
}
