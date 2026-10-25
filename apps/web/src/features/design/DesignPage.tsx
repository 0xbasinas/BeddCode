import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { Select } from '../../ui/Select.tsx'
import { useHostDesign, type DesignSync } from './hostDesign.ts'
import { EditorLayout } from './components/editor/EditorLayout.tsx'
import { Toaster } from './components/ui/toaster.tsx'
import './design.css'

const SYNC_LABEL: Record<DesignSync, string> = {
  loading: 'Opening…',
  saved: 'Saved to host',
  saving: 'Saving…',
  offline: 'Host not reachable',
}

/** The design canvas: its own screen, in the main area beside the sidebar. */
export function DesignPage() {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [hostKey, setHostKey] = useState(LOCAL_HOST_KEY)
  const selected = entries.some((e) => e.key === hostKey) ? hostKey : LOCAL_HOST_KEY
  const { designs, currentId, sync, create, remove, switchTo } = useHostDesign(selected)
  return (
    <main className="panel design-main">
      <div className="design-bar">
        {entries.length > 1 && (
          <Select aria-label="Design host" value={selected} onChange={(e) => setHostKey(e.target.value)}>
            {entries.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.key === LOCAL_HOST_KEY
                  ? 'This PC'
                  : (runtimes[entry.key]?.host?.name ?? entry.name)}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Design"
          value={currentId ?? undefined}
          onChange={(e) => void switchTo(e.target.value)}
          disabled={designs.length === 0}
        >
          {designs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <button
          type="button"
          className="design-bar-btn"
          title="New design"
          aria-label="New design"
          onClick={() => void create()}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="design-bar-btn"
          title="Delete this design"
          aria-label="Delete this design"
          disabled={!currentId || designs.length === 0}
          onClick={() => {
            if (currentId && window.confirm('Delete this design from the host?')) void remove(currentId)
          }}
        >
          <Trash2 size={14} />
        </button>
        <span className={`design-sync ${sync}`}>{SYNC_LABEL[sync]}</span>
      </div>
      <div className="design-editor">
        <EditorLayout />
      </div>
      <Toaster />
    </main>
  )
}
