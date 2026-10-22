import { useEffect } from 'react'
import { create } from 'zustand'
import type { Project } from '@beddcode/contracts'
import { addProject, hostRequest, refreshProjects, useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { desktopBridge } from '../../ui/desktop.ts'
import { addOutcome, rememberFolder, samePath } from './folderLogic.ts'

export type FolderToastKind = 'added' | 'not-git' | 'already' | 'git-ready' | 'error'

export interface FolderToast {
  id: number
  kind: FolderToastKind
  hostKey: string
  project?: Project
  message?: string
}

interface FolderFlowState {
  toast?: FolderToast
  /** A sidebar group to draw attention to (the folder that was already there). */
  highlight?: { hostKey: string; path: string; id: number }
  /** Folders added in this window, marked "New" until they get a session. */
  fresh: { hostKey: string; path: string }[]
  /** The most recent folder added per host, for the welcome checklist. */
  lastAdded: Record<string, string>
  /** The in-app folder browser, open for one host. */
  browser?: { hostKey: string; id: number }
  /** The system folder picker is open. */
  picking: boolean
  /** Host the Add folder menu (and Ctrl+O) adds to. */
  menuHostKey: string
  /** Folders picked before, per host, most recent first. */
  history: Record<string, string[]>
  /** Each host's home folder, learned from the folder browser, to show paths as `~/…`. */
  homes: Record<string, string>
  setMenuHostKey(hostKey: string): void
  dismissToast(): void
}

const HISTORY_KEY = 'beddcode.recent-folders'

function loadHistory(): Record<string, string[]> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(HISTORY_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [],
      ]),
    )
  } catch {
    return {}
  }
}

function saveHistory(history: Record<string, string[]>) {
  try {
    globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch {
    // Recent folders are a convenience; the next launch simply starts without them.
  }
}

let nextId = 1

export const useFolderFlow = create<FolderFlowState>((set) => ({
  fresh: [],
  lastAdded: {},
  picking: false,
  menuHostKey: LOCAL_HOST_KEY,
  history: loadHistory(),
  homes: {},
  setMenuHostKey: (menuHostKey) => set({ menuHostKey }),
  dismissToast: () => set({ toast: undefined }),
}))

const showToast = (toast: Omit<FolderToast, 'id'>) =>
  useFolderFlow.setState({ toast: { ...toast, id: nextId++ } })

/** The system picker only sees this computer, and only the desktop app can open it. */
export function hasNativePicker(hostKey: string): boolean {
  return hostKey === LOCAL_HOST_KEY && typeof desktopBridge()?.pickFolder === 'function'
}

let browserResolve: ((path: string | null) => void) | undefined

/** Resolves with the folder chosen in the in-app browser, or null when it is closed. */
function openBrowser(hostKey: string): Promise<string | null> {
  browserResolve?.(null)
  return new Promise((resolve) => {
    browserResolve = resolve
    useFolderFlow.setState({ browser: { hostKey, id: nextId++ } })
  })
}

/** Called by the folder browser when the user picks a folder (or cancels with null). */
export function closeBrowser(path: string | null) {
  const resolve = browserResolve
  browserResolve = undefined
  useFolderFlow.setState({ browser: undefined })
  resolve?.(path)
}

/**
 * Lets the user pick a folder on a host and adds it: the system picker on this computer inside
 * the desktop app, the in-app browser everywhere else. Nothing is typed. Resolves with the added
 * folder, or undefined when the user cancelled or adding failed (a toast says why).
 */
export async function chooseFolder(hostKey: string): Promise<Project | undefined> {
  const state = useFolderFlow.getState()
  if (state.picking || state.browser) return undefined
  let picked: string | null
  if (hasNativePicker(hostKey)) {
    const last = state.history[hostKey]?.[0]
    useFolderFlow.setState({ picking: true })
    try {
      picked = await desktopBridge()!.pickFolder!({
        defaultPath: last ? parentOf(last) : undefined,
      })
    } catch (err) {
      showToast({ kind: 'error', hostKey, message: errorText(err) })
      return undefined
    } finally {
      useFolderFlow.setState({ picking: false })
    }
  } else {
    picked = await openBrowser(hostKey)
  }
  return picked ? addFolder(hostKey, picked) : undefined
}

/** Adds a folder the user picked (never typed) and reports the outcome in a toast. */
export async function addFolder(hostKey: string, path: string): Promise<Project | undefined> {
  const before = useHostStore.getState().runtimes[hostKey]?.projects ?? []
  let project: Project
  try {
    project = await addProject(hostKey, path)
  } catch (err) {
    showToast({ kind: 'error', hostKey, message: errorText(err) })
    return undefined
  }
  const outcome = addOutcome(before, project)
  useFolderFlow.setState((s) => {
    const history = {
      ...s.history,
      [hostKey]: rememberFolder(s.history[hostKey] ?? [], project.path),
    }
    saveHistory(history)
    return {
      history,
      lastAdded: { ...s.lastAdded, [hostKey]: project.path },
      fresh: outcome === 'added' ? [...s.fresh, { hostKey, path: project.path }] : s.fresh,
      highlight:
        outcome === 'already' ? { hostKey, path: project.path, id: nextId++ } : s.highlight,
    }
  })
  showToast({
    kind: outcome === 'already' ? 'already' : project.isRepo ? 'added' : 'not-git',
    hostKey,
    project,
  })
  return project
}

/** `git init` in an added folder, only ever after the user asked for it. */
export async function initGit(hostKey: string, path: string) {
  try {
    const project = await hostRequest(hostKey, 'projects.initGit', { path })
    await refreshProjects(hostKey)
    showToast({ kind: 'git-ready', hostKey, project })
  } catch (err) {
    showToast({ kind: 'error', hostKey, message: errorText(err) })
  }
}

export function isFresh(fresh: FolderFlowState['fresh'], hostKey: string, path: string) {
  return fresh.some((f) => f.hostKey === hostKey && samePath(f.path, path))
}

function parentOf(p: string): string {
  const cut = p.replace(/[\\/]+$/, '').search(/[\\/][^\\/]*$/)
  return cut > 0 ? p.slice(0, cut) : p
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function rememberHome(hostKey: string, home: string) {
  if (useFolderFlow.getState().homes[hostKey] === home) return
  useFolderFlow.setState((s) => ({ homes: { ...s.homes, [hostKey]: home } }))
}

/** A host's home folder (asked once per window), so paths can be shown as `~/…`. */
export function useHostHome(hostKey: string, connected: boolean): string | undefined {
  const home = useFolderFlow((s) => s.homes[hostKey])
  useEffect(() => {
    if (home || !connected) return
    hostRequest(hostKey, 'folders.browse', {}).then(
      (listing) => rememberHome(hostKey, listing.home),
      () => {},
    )
  }, [hostKey, home, connected])
  return home
}
