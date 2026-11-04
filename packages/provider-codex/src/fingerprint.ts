import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RELEVANT_ENV =
  /^(CODEX_|OPENAI_|AZURE_|HOME$|PATH$|XDG_|(HTTPS?|ALL|NO)_PROXY$|SSL_CERT|NODE_EXTRA_CA_CERTS$)/i

interface FileStat {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

/** Only digests and file metadata are cached; file contents and environment values are not. */
export function createCodexFingerprint(
  executable: () => string | null,
  environment: () => NodeJS.ProcessEnv,
  fs = {
    stat: statSync as (file: string) => FileStat,
    read: readFileSync as (file: string) => Buffer,
    realpath: realpathSync as (file: string) => string,
  },
  homeDirectory = os.homedir,
): () => string {
  const fileDigests = new Map<string, { metadata: string; digest: string }>()
  return () => {
    const env = environment()
    const exe = executable()
    const binary = exe ? fs.realpath(exe) : null
    const binaryStat = binary ? fs.stat(binary) : null
    const home = env.CODEX_HOME || path.join(env.HOME || homeDirectory(), '.codex')
    const files = ['config.toml', 'auth.json'].map((name) => {
      const file = path.join(home, name)
      try {
        const stat = fs.stat(file)
        const metadata = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
        let cached = fileDigests.get(file)
        if (!cached || cached.metadata !== metadata) {
          cached = { metadata, digest: createHash('sha256').update(fs.read(file)).digest('hex') }
          fileDigests.set(file, cached)
        }
        return cached.digest
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        fileDigests.delete(file)
        return null
      }
    })
    return createHash('sha256')
      .update(
        JSON.stringify([
          binary,
          binaryStat && [binaryStat.size, binaryStat.mtimeMs, binaryStat.ctimeMs],
          files,
          Object.entries(env)
            .filter(([name]) => RELEVANT_ENV.test(name))
            .sort(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      .digest('hex')
  }
}
