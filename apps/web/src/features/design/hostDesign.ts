import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesignSummary } from '@beddcode/contracts'
import { hostRequest, onHostFrame } from '../../stores/host.ts'
import { useEditorStore } from './store/editor-store'
import { buildProjectPayload } from './lib/server-project'

const SAVE_DELAY_MS = 500
const lastKey = (hostKey: string) => `beddcode.design.${hostKey}`

function remembered(hostKey: string): string | null {
  try {
    return localStorage.getItem(lastKey(hostKey))
  } catch {
    return null
  }
}

function remember(hostKey: string, id: string) {
  try {
    localStorage.setItem(lastKey(hostKey), id)
  } catch {
    // not remembered; the newest design opens next time
  }
}

/** One creation at a time per host, so React running an effect twice does not make two designs. */
const creating = new Map<string, Promise<string>>()
function createFirst(hostKey: string): Promise<string> {
  let p = creating.get(hostKey)
  if (!p) {
    p = hostRequest(hostKey, 'design.create', {})
      .then((d) => d.id)
      .finally(() => creating.delete(hostKey))
    creating.set(hostKey, p)
  }
  return p
}

export type DesignSync = 'loading' | 'saved' | 'saving' | 'offline'

/**
 * Keeps the editor and one design on a host in step: edits are saved to the host a moment after
 * they happen, and changes made elsewhere (another window, an agent's design tools) are loaded
 * into the open canvas as they arrive.
 */
export function useHostDesign(hostKey: string) {
  const [designs, setDesigns] = useState<DesignSummary[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [sync, setSync] = useState<DesignSync>('loading')
  const rev = useRef(0)
  const current = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saving = useRef(false)

  const refreshList = useCallback(async () => {
    const { designs } = await hostRequest(hostKey, 'design.list', {})
    setDesigns(designs)
    return designs
  }, [hostKey])

  const open = useCallback(
    async (id: string) => {
      setSync('loading')
      const design = await hostRequest(hostKey, 'design.get', { id })
      clearTimeout(timer.current)
      useEditorStore.getState().loadHostProject(design.project)
      rev.current = design.rev
      current.current = id
      setCurrentId(id)
      remember(hostKey, id)
      setSync('saved')
    },
    [hostKey],
  )

  // The first design to show: the one used last on this host, else the newest, else a new one.
  useEffect(() => {
    let cancelled = false
    current.current = null
    setCurrentId(null)
    setSync('loading')
    void (async () => {
      try {
        const list = await refreshList()
        const wanted = remembered(hostKey)
        const first =
          list.find((d) => d.id === wanted)?.id ??
          list[0]?.id ??
          (await createFirst(hostKey))
        if (cancelled) return
        await open(first)
        if (!list.some((d) => d.id === first)) void refreshList()
      } catch {
        if (!cancelled) setSync('offline')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hostKey, open, refreshList])

  const save = useCallback(async () => {
    const id = current.current
    const state = useEditorStore.getState()
    if (!id || !state.isDirty || saving.current) return
    saving.current = true
    setSync('saving')
    try {
      const saved = await hostRequest(hostKey, 'design.save', {
        id,
        project: buildProjectPayload(state),
        origin: state.clientId,
      })
      rev.current = saved.rev
      const now = useEditorStore.getState()
      // Edits made while saving stay dirty and go out with the next save.
      if (now.elements === state.elements && now.pages === state.pages) now.setDirty(false)
      else timer.current = setTimeout(() => void save(), SAVE_DELAY_MS)
      setDesigns((list) => list.map((d) => (d.id === id ? saved : d)))
      setSync('saved')
    } catch {
      setSync('offline')
      timer.current = setTimeout(() => void save(), 5000)
    } finally {
      saving.current = false
    }
  }, [hostKey])

  // Save shortly after the canvas changes; flush when leaving the screen.
  useEffect(() => {
    const stop = useEditorStore.subscribe((s) => {
      if (!s.isDirty || !current.current) return
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void save(), SAVE_DELAY_MS)
    })
    return () => {
      stop()
      clearTimeout(timer.current)
      void save()
    }
  }, [save])

  // Changes from elsewhere.
  useEffect(
    () =>
      onHostFrame(hostKey, (frame) => {
        if (frame.t !== 'design.changed') return
        const clientId = useEditorStore.getState().clientId
        void refreshList().catch(() => {})
        if (frame.id !== current.current || frame.origin === clientId || frame.rev <= rev.current)
          return
        void hostRequest(hostKey, 'design.get', { id: frame.id }).then((design) => {
          if (design.id !== current.current || design.rev <= rev.current) return
          rev.current = design.rev
          useEditorStore.getState().applyRemoteProject(design.project)
        }, () => {})
      }),
    [hostKey, refreshList],
  )

  const create = useCallback(async () => {
    await save()
    const design = await hostRequest(hostKey, 'design.create', {})
    await refreshList()
    await open(design.id)
  }, [hostKey, open, refreshList, save])

  const remove = useCallback(
    async (id: string) => {
      await hostRequest(hostKey, 'design.delete', { id })
      const list = await refreshList()
      const next = list[0]?.id ?? (await createFirst(hostKey))
      if (id === current.current) await open(next)
      void refreshList()
    },
    [hostKey, open, refreshList],
  )

  const switchTo = useCallback(
    async (id: string) => {
      if (id === current.current) return
      await save()
      await open(id)
    },
    [open, save],
  )

  return { designs, currentId, sync, create, remove, switchTo }
}
