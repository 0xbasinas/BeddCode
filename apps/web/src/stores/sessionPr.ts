import { useEffect } from 'react'
import { create } from 'zustand'
import type { PrCheckState, PullRequest } from '@beddcode/contracts'
import { hostRequest } from './host.ts'

/** What a session row needs of its branch's pull request. */
export interface SessionPrInfo {
  number: number
  title: string
  url: string
  state: PullRequest['state']
  isDraft: boolean
  checks?: PrCheckState
  checksFailed: number
  checksPending: number
}

const KEY = 'beddcode.session-prs'
/** Rows ask GitHub for a folder at most this often; the server also shares its answers. */
const STALE_MS = 5 * 60_000
/** An open pull request can be merged anywhere, so it is looked at again sooner. */
const OPEN_STALE_MS = 60_000

interface Entry {
  /** The last answer; null once GitHub said there is no pull request. */
  pr: SessionPrInfo | null
  at: number
}

interface SessionPrState {
  entries: Record<string, Entry>
}

const load = (): Record<string, Entry> => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return saved && typeof saved === 'object' ? (saved as Record<string, Entry>) : {}
  } catch {
    return {}
  }
}

/** The last known pull request per host and folder, kept between runs so rows show at once. */
export const useSessionPrs = create<SessionPrState>(() => ({ entries: load() }))

const keyOf = (hostKey: string, cwd: string) => `${hostKey}\n${cwd}`

/** What a session knows about where its pull request lives when its folder is gone. */
export interface PrSource {
  branch?: string
  repo?: string
}

function summarize(pr: PullRequest): SessionPrInfo {
  const failed = pr.checks.filter((c) => c.state === 'failure').length
  const pending = pr.checks.filter((c) => c.state === 'pending').length
  const passed = pr.checks.filter((c) => c.state === 'success').length
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    checks: !pr.checks.length
      ? undefined
      : failed
        ? 'failure'
        : pending
          ? 'pending'
          : passed
            ? 'success'
            : 'skipped',
    checksFailed: failed,
    checksPending: pending,
  }
}

const inflight = new Map<string, Promise<void>>()

/** Asks for one folder's pull request; rows of the same folder share one request. */
function refresh(hostKey: string, cwd: string, source?: PrSource): Promise<void> {
  const key = keyOf(hostKey, cwd)
  const running = inflight.get(key)
  if (running) return running
  const request = hostRequest(hostKey, 'git.pr.get', { cwd, ...source })
    .then(
      (pr) => {
        const known = useSessionPrs.getState().entries[key]?.pr
        // Once merged, the pull request stays on the row even after its branch and worktree are
        // deleted, when GitHub can no longer be asked for it by the folder's branch.
        const next = pr ? summarize(pr) : known?.state === 'MERGED' ? known : null
        const entries = {
          ...useSessionPrs.getState().entries,
          [key]: { pr: next, at: Date.now() },
        }
        useSessionPrs.setState({ entries })
        try {
          localStorage.setItem(KEY, JSON.stringify(entries))
        } catch {
          // Still works for this window.
        }
      },
      () => {
        // No gh, signed out or offline: keep what was last known.
      },
    )
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

/** Asks GitHub for a folder's pull request now, however fresh the last answer is. */
export const refreshSessionPr = refresh

/**
 * The pull request of a folder's current branch for a session row. Shows the last known answer
 * straight away, then refreshes it when it is stale and every few minutes while the row is shown.
 */
export function useSessionPr(
  hostKey: string,
  cwd: string,
  source?: PrSource,
): SessionPrInfo | null {
  const key = keyOf(hostKey, cwd)
  const { branch, repo } = source ?? {}
  const entry = useSessionPrs((s) => s.entries[key])
  useEffect(() => {
    const due = () => {
      const entry = useSessionPrs.getState().entries[key]
      // A merged pull request does not change again.
      if (entry?.pr?.state === 'MERGED') return
      const limit = entry?.pr?.state === 'OPEN' ? OPEN_STALE_MS : STALE_MS
      if (document.visibilityState === 'visible' && Date.now() - (entry?.at ?? 0) >= limit) {
        void refresh(hostKey, cwd, { branch, repo })
      }
    }
    due()
    const timer = setInterval(due, 30_000)
    return () => clearInterval(timer)
  }, [hostKey, cwd, key, branch, repo])
  return entry?.pr ?? null
}
