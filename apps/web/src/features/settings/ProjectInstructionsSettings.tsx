import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { hostRequest, refreshProjects, useHostStore } from '../../stores/host.ts'
import { Select } from '../../ui/Select.tsx'

export function ProjectInstructionsSettings() {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const projects = useMemo(
    () =>
      entries.flatMap((entry) =>
        (runtimes[entry.key]?.projects ?? []).map((project) => ({
          ...project,
          hostKey: entry.key,
          hostName: entry.name,
        })),
      ),
    [entries, runtimes],
  )
  const [selection, setSelection] = useState('')
  const selected = projects.find((p) => JSON.stringify([p.hostKey, p.path]) === selection)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    setText(selected?.instructions ?? '')
    setMessage('')
  }, [selection, selected?.instructions])
  async function save() {
    if (!selected) return
    setBusy(true)
    setMessage('')
    try {
      await hostRequest(selected.hostKey, 'projects.setInstructions', {
        path: selected.path,
        instructions: text,
      })
      await refreshProjects(selected.hostKey)
      setMessage('Saved. New sessions will use these instructions.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <header className="settings-heading">
        <h2>Project instructions</h2>
      </header>
      <p className="muted">
        Shared instructions are stored on the host and included in prompts for new sessions with any
        agent. Existing sessions keep the instructions they started with.
      </p>
      <label htmlFor="instructions-project">Project</label>
      <Select
        id="instructions-project"
        value={selection}
        onChange={(e) => setSelection(e.target.value)}
      >
        <option value="">Select a project</option>
        {projects.map((p) => (
          <option
            key={JSON.stringify([p.hostKey, p.path])}
            value={JSON.stringify([p.hostKey, p.path])}
          >
            {p.name} — {p.path} ({p.hostName})
          </option>
        ))}
      </Select>
      {selected && (
        <div>
          <label htmlFor="project-instructions">Instructions for {selected.name}</label>
          <textarea
            id="project-instructions"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={32000}
            rows={12}
            style={{ width: '100%' }}
          />
          <Button
            variant="app"
            disabled={busy || text === (selected.instructions ?? '')}
            onClick={() => void save()}
          >
            Save instructions
          </Button>
          <p role="status">{message}</p>
        </div>
      )}
      {!projects.length && <p className="muted">Add a project to set instructions.</p>}
    </>
  )
}
