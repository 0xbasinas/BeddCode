import { create } from 'zustand'
import type { RpcParams } from '@beddcode/contracts'
import { hostRequest } from '../../stores/host.ts'

export interface GitOperation {
  kind: 'commit' | 'commit-and-push' | 'push'
  pending: boolean
  hash?: string
  pushed?: boolean
  error?: string
}

interface Entry {
  revision: number
  operation?: GitOperation
}

export const EMPTY_OPERATION: Entry = { revision: 0 }
export const gitOperationKey = (hostKey: string, cwd: string) => JSON.stringify([hostKey, cwd])

/** Operation results outlive individual tabs and panes. They are scoped to the owning host/folder. */
export const useGitOperations = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }))

function save(key: string, operation: GitOperation, completed: boolean) {
  useGitOperations.setState((s) => ({
    entries: {
      ...s.entries,
      [key]: { revision: (s.entries[key]?.revision ?? 0) + Number(completed), operation },
    },
  }))
}

async function perform<T>(
  hostKey: string,
  cwd: string,
  kind: GitOperation['kind'],
  request: () => Promise<T>,
  result: (value: T) => Partial<GitOperation>,
): Promise<T> {
  const key = gitOperationKey(hostKey, cwd)
  const previous = useGitOperations.getState().entries[key]?.operation
  if (previous?.pending) throw new Error('A Git operation is already running for this folder')
  const operation: GitOperation = {
    kind,
    pending: true,
    hash: kind === 'push' ? previous?.hash : undefined,
  }
  save(key, operation, false)
  try {
    const value = await request()
    save(key, { ...operation, ...result(value), pending: false }, true)
    return value
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    save(
      key,
      {
        ...operation,
        pending: false,
        error: kind === 'push' ? `Push failed: ${message}` : message,
      },
      true,
    )
    throw err
  }
}

export function commitFiles(hostKey: string, params: RpcParams<'git.commit'>) {
  return perform(
    hostKey,
    params.cwd,
    params.push ? 'commit-and-push' : 'commit',
    () => hostRequest(hostKey, 'git.commit', params),
    (result) => ({
      hash: result.hash,
      pushed: result.pushed,
      error:
        params.push && !result.pushed
          ? `Commit saved. Push failed: ${result.pushError ?? 'The host did not confirm the push.'}`
          : undefined,
    }),
  )
}

export function pushBranch(hostKey: string, cwd: string) {
  return perform(
    hostKey,
    cwd,
    'push',
    () => hostRequest(hostKey, 'git.push', { cwd }),
    () => ({ pushed: true }),
  )
}

export function dismissGitOperation(hostKey: string, cwd: string) {
  const key = gitOperationKey(hostKey, cwd)
  useGitOperations.setState((s) => {
    const entry = s.entries[key]
    if (!entry || entry.operation?.pending) return s
    return { entries: { ...s.entries, [key]: { revision: entry.revision } } }
  })
}
