import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { RpcResult } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'

type EditorList = RpcResult<'editors.list'>
const PREFERRED_KEY = 'beddcode.preferred-editor'

const readPreferred = () => {
  try {
    return globalThis.localStorage?.getItem(PREFERRED_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Installed editors per host (asked once per connection), and the one picked last. */
export const useEditorStore = create<{
  byHost: Record<string, EditorList & { epoch: number }>
  preferred?: string
}>(() => ({ byHost: {}, preferred: readPreferred() }))

const pending = new Map<string, Promise<void>>()

/** The host's editors; empty until known, and when the host is older than this app. */
export function useEditors(hostKey: string): EditorList & { preferredId?: string } {
  const { epoch, connection } = useRuntime(hostKey)
  const known = useEditorStore((s) => s.byHost[hostKey])
  const preferred = useEditorStore((s) => s.preferred)
  useEffect(() => {
    if (connection !== 'connected' || known?.epoch === epoch || pending.has(hostKey)) return
    const request = hostRequest(hostKey, 'editors.list', {})
      .then((list) =>
        useEditorStore.setState((s) => ({
          byHost: { ...s.byHost, [hostKey]: { ...list, epoch } },
        })),
      )
      .catch(() =>
        useEditorStore.setState((s) => ({
          byHost: { ...s.byHost, [hostKey]: { editors: [], canOpen: false, epoch } },
        })),
      )
      .finally(() => pending.delete(hostKey))
    pending.set(hostKey, request)
  }, [hostKey, epoch, connection, known?.epoch])
  const editors = known?.editors ?? []
  const preferredId = editors.some((e) => e.id === preferred) ? preferred : editors[0]?.id
  return { editors, canOpen: known?.canOpen ?? false, platform: known?.platform, preferredId }
}

/** Opens the folder (and a file at a line) in an editor, remembering it as the preferred one. */
export async function openInEditor(
  hostKey: string,
  editor: string,
  target: { cwd: string; path?: string; line?: number; column?: number },
): Promise<void> {
  try {
    globalThis.localStorage?.setItem(PREFERRED_KEY, editor)
  } catch {
    // Storage blocked: the choice lasts for this run only.
  }
  useEditorStore.setState({ preferred: editor })
  await hostRequest(hostKey, 'editors.open', { editor, ...target })
}

/** A short-lived error line for a failed open. */
export function useOpenError(): [string | null, (message: string | null) => void] {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 5000)
    return () => clearTimeout(timer)
  }, [error])
  return [error, setError]
}
