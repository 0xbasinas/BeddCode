import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Logger } from '@beddcode/shared'
import { IGNORED_DIRS } from './files.ts'

export type ChangeListener = (paths: string[]) => void

interface Watch {
  watcher: FSWatcher
  listeners: Set<ChangeListener>
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  /** Set once the watcher errored, so its handler does not re-enter. */
  dead: boolean
  retry: ReturnType<typeof setTimeout> | null
}

const DEBOUNCE_MS = 120
/** Past this many changes in one burst (a checkout, an install) clients just refresh everything. */
const MAX_PATHS = 300
/** Re-establishing a failed watch: wait 5 s, doubling up to a minute. */
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 60_000

/**
 * One file watcher per folder, shared by every client that watches it and stopped when the last
 * one leaves. Changes are grouped into short bursts. A watcher that fails (permissions, too many
 * files, the folder being deleted) is re-established while anyone still listens; it never takes
 * the server down.
 */
export class FileWatchers {
  private readonly watches = new Map<string, Watch>()

  constructor(
    private readonly changed?: (cwd: string) => void,
    private readonly log?: Pick<Logger, 'warn'>,
  ) {}

  /** Starts (or joins) watching `cwd`. Returns the function that stops listening. */
  acquire(cwd: string, listener: ChangeListener): () => void {
    const key = path.resolve(cwd)
    let watch = this.watches.get(key)
    if (!watch) {
      watch = this.start(key)
      this.watches.set(key, watch)
    }
    watch.listeners.add(listener)
    return () => {
      const w = this.watches.get(key)
      if (!w) return
      w.listeners.delete(listener)
      if (w.listeners.size === 0) {
        this.watches.delete(key)
        if (w.timer) clearTimeout(w.timer)
        if (w.retry) clearTimeout(w.retry)
        w.dead = true
        void w.watcher.close().catch(() => {})
      }
    }
  }

  async closeAll() {
    const all = [...this.watches.values()]
    this.watches.clear()
    await Promise.all(
      all.map((w) => {
        w.dead = true
        w.listeners.clear()
        if (w.timer) clearTimeout(w.timer)
        if (w.retry) clearTimeout(w.retry)
        return w.watcher.close().catch(() => {})
      }),
    )
  }

  private start(root: string, listeners?: Set<ChangeListener>, attempt = 0): Watch {
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      depth: 12,
      // Dependency and build folders change constantly and nobody looks at them live.
      ignored: (p) => {
        const parts = path.relative(root, p).split(path.sep)
        return parts.includes('.git') || parts.some((part) => IGNORED_DIRS.has(part))
      },
    })
    const watch: Watch = {
      watcher,
      listeners: listeners ?? new Set(),
      pending: new Set(),
      timer: null,
      dead: false,
      retry: null,
    }

    const note = (file: string) => {
      if (watch.dead) return
      watch.pending.add(path.relative(root, file).split(path.sep).join('/'))
      watch.timer ??= setTimeout(() => {
        watch.timer = null
        try {
          this.changed?.(root)
        } catch (err) {
          this.log?.warn(String(err))
        }
        const paths = [...watch.pending]
        watch.pending.clear()
        const out = paths.length > MAX_PATHS ? ['.'] : paths
        for (const l of watch.listeners) {
          try {
            l(out)
          } catch (err) {
            this.log?.warn(
              `file watch listener failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }, DEBOUNCE_MS)
    }
    for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
      watcher.on(event, note)
    }
    // A watcher that fails (permissions, too many files, the folder deleted meanwhile) is
    // re-established while anyone still listens; the error itself must not take the server down.
    watcher.on('error', (err: unknown) => {
      if (watch.dead) return
      watch.dead = true
      this.log?.warn(
        `file watcher for ${root} failed, re-establishing: ${err instanceof Error ? err.message : String(err)}`,
      )
      const key = path.resolve(root)
      if (watch.timer) clearTimeout(watch.timer)
      void watcher.close().catch(() => {})
      if (watch.listeners.size === 0) return
      const retry = () => {
        const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(attempt++, 4))
        watch.retry = setTimeout(() => {
          if (watch.listeners.size === 0 || this.watches.get(key) !== watch) return
          try {
            const next = this.start(root, watch.listeners, attempt)
            this.watches.set(key, next)
          } catch (err) {
            this.log?.warn(`could not restart file watcher: ${String(err)}`)
            retry()
          }
        }, delay)
        watch.retry.unref?.()
      }
      retry()
    })
    watcher.on('ready', () => {
      attempt = 0
    })
    return watch
  }
}
