import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Play, Plus, Settings2, Trash2 } from 'lucide-react'
import type { Project, ProjectScript } from '@beddcode/contracts'
import { hostRequest, refreshProjects } from '../../stores/host.ts'

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * The folder's saved commands (install, dev server, tests…): one click runs each in a new
 * terminal. Scripts marked "on new worktree" also run by themselves when a worktree is made.
 */
export function ProjectScripts({
  hostKey,
  project,
  onRun,
}: {
  hostKey: string
  project: Project
  onRun(script: ProjectScript): void
}) {
  const scripts = project.scripts ?? []
  const [editing, setEditing] = useState<ProjectScript[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const save = async () => {
    if (!editing) return
    const cleaned = editing
      .map((s) => ({ ...s, name: s.name.trim(), command: s.command.trim() }))
      .filter((s) => s.name && s.command)
    setSaving(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'projects.setScripts', { path: project.path, scripts: cleaned })
      await refreshProjects(hostKey)
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  const update = (id: string, patch: Partial<ProjectScript>) =>
    setEditing((list) => list && list.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  if (editing) {
    return (
      <div className="scripts-editor" role="group" aria-label="Folder scripts">
        <p className="muted small">
          Commands for {project.name}. Each runs in a new terminal in the session's folder.
        </p>
        {editing.map((s) => (
          <div key={s.id} className="script-row">
            <input
              className="script-name"
              aria-label="Script name"
              placeholder="Name"
              maxLength={40}
              value={s.name}
              onChange={(e) => update(s.id, { name: e.target.value })}
            />
            <input
              className="script-command"
              aria-label="Command"
              placeholder="pnpm install"
              maxLength={2000}
              value={s.command}
              spellCheck={false}
              onChange={(e) => update(s.id, { command: e.target.value })}
            />
            <label className="script-auto" title="Run by itself when a worktree is made">
              <Checkbox
                checked={Boolean(s.runOnWorktreeCreate)}
                onCheckedChange={(checked) =>
                  update(s.id, { runOnWorktreeCreate: checked === true || undefined })
                }
              />
              On new worktree
            </label>
            <Button
              variant="app"
              className="icon-btn"
              aria-label={`Remove ${s.name || 'script'}`}
              onClick={() => setEditing((list) => list && list.filter((x) => x.id !== s.id))}
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
        {error && <div className="composer-error">{error}</div>}
        <div className="scripts-editor-actions">
          <Button
            variant="app"
            className="link-btn"
            disabled={editing.length >= 20}
            onClick={() =>
              setEditing((list) => [...(list ?? []), { id: newId(), name: '', command: '' }])
            }
          >
            <Plus size={14} /> Add script
          </Button>
          <span className="spacer" />
          <Button
            variant="app"
            className="secondary-btn"
            disabled={saving}
            onClick={() => setEditing(null)}
          >
            Cancel
          </Button>
          <Button
            variant="app"
            className="primary-btn"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="scripts-bar" aria-label="Folder scripts">
      {scripts.map((s) => (
        <button
          key={s.id}
          className="script-btn"
          title={`Run in a new terminal: ${s.command}`}
          onClick={() => onRun(s)}
        >
          <Play size={12} /> {s.name}
        </button>
      ))}
      <button
        className="script-btn subtle"
        title="Add or change this folder's scripts"
        onClick={() =>
          setEditing(
            scripts.length > 0
              ? scripts.map((s) => ({ ...s }))
              : [{ id: newId(), name: 'Install', command: '', runOnWorktreeCreate: true }],
          )
        }
      >
        <Settings2 size={12} /> {scripts.length > 0 ? 'Edit' : 'Add script'}
      </button>
    </div>
  )
}
