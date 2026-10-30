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
function refresh(hostKey: string, cwd: string): Promise<void> {
  const key = keyOf(hostKey, cwd)
  const running = inflight.get(key)
  if (running) return running
  const request = hostRequest(hostKey, 'git.pr.get', { cwd })
    .then(
      (pr) => {
        const entries = {
          ...useSessionPrs.getState().entries,
          [key]: { pr: pr && summarize(pr), at: Date.now() },
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
export function useSessionPr(hostKey: string, cwd: string): SessionPrInfo | null {
  const key = keyOf(hostKey, cwd)
  const entry = useSessionPrs((s) => s.entries[key])
  useEffect(() => {
    const due = () => {
      const at = useSessionPrs.getState().entries[key]?.at ?? 0
      if (document.visibilityState === 'visible' && Date.now() - at >= STALE_MS) {
        void refresh(hostKey, cwd)
      }
    }
    due()
    const timer = setInterval(due, 30_000)
    return () => clearInterval(timer)
  }, [hostKey, cwd, key])
  return entry?.pr ?? null
}
