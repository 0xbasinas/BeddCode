import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { IGNORED_DIRS } from './files.ts'

export type ChangeListener = (paths: string[]) => void

interface Watch {
  watcher: FSWatcher
  listeners: Set<ChangeListener>
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
}

const DEBOUNCE_MS = 120
/** Past this many changes in one burst (a checkout, an install) clients just refresh everything. */
const MAX_PATHS = 300

/**
 * One file watcher per folder, shared by every client that watches it and stopped when the last
 * one leaves. Changes are grouped into short bursts.
 */
export class FileWatchers {
  private readonly watches = new Map<string, Watch>()

  constructor(private readonly changed?: (cwd: string) => void) {}

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
        void w.watcher.close()
      }
    }
  }

  async closeAll() {
    const all = [...this.watches.values()]
    this.watches.clear()
    await Promise.all(all.map((w) => w.watcher.close()))
  }

  private start(root: string): Watch {
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
    const watch: Watch = { watcher, listeners: new Set(), pending: new Set(), timer: null }

    const note = (file: string) => {
      watch.pending.add(path.relative(root, file).split(path.sep).join('/'))
      watch.timer ??= setTimeout(() => {
        watch.timer = null
        this.changed?.(root)
        const paths = [...watch.pending]
        watch.pending.clear()
        const out = paths.length > MAX_PATHS ? ['.'] : paths
        for (const l of watch.listeners) l(out)
      }, DEBOUNCE_MS)
    }
    for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
      watcher.on(event, note)
    }
    // A watcher that fails (permissions, too many files) must not take the server down.
    watcher.on('error', () => {})
    return watch
  }
}
