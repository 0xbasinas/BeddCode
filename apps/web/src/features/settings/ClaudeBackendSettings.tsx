import { useEffect, useState } from 'react'
import type { Project } from '@beddcode/contracts'
import { hostRequest, refreshProjects } from '../../stores/host.ts'
import { Select } from '../../ui/Select.tsx'

export function ClaudeBackendSettings({ hostKey, projects, online }: { hostKey: string; projects: Project[]; online: boolean }) {
  const [hostBackend, setHostBackend] = useState<'sdk' | 'cli'>()
  useEffect(() => {
    let active = true
    setHostBackend(undefined)
    if (online) hostRequest(hostKey, 'host.claudeBackend.get', {}).then((result) => { if (active) setHostBackend(result.claudeBackend) }, (err) => { if (active) setError(err instanceof Error ? err.message : String(err)) })
    return () => { active = false }
  }, [hostKey, online])
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const project = projects.find((p) => p.path === path)
  async function save(value: string) {
    if (!project) return
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'projects.setClaudeBackend', { path: project.path, claudeBackend: value === 'sdk' || value === 'cli' ? value : null })
      await refreshProjects(hostKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  async function saveHost(value: 'sdk' | 'cli') {
    setBusy(true)
    setError(undefined)
    try {
      const result = await hostRequest(hostKey, 'host.claudeBackend.set', { claudeBackend: value })
      setHostBackend(result.claudeBackend)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  return <div className="settings-card">
    <h3>Host Claude backend</h3>
    <label htmlFor="claude-host-backend">Claude backend</label>{' '}
    <Select id="claude-host-backend" value={hostBackend ?? ''} disabled={!online || !hostBackend || busy} onChange={(e) => void saveHost(e.target.value as 'sdk' | 'cli')}>
      {!hostBackend && <option value="">Loading…</option>}
      <option value="sdk">Claude SDK</option>
      <option value="cli">Claude CLI</option>
    </Select>
    <h3>Project Claude backend</h3>
    <label htmlFor="claude-project">Project</label>{' '}
    <Select id="claude-project" value={path} disabled={!online || busy} onChange={(e) => setPath(e.target.value)}>
      <option value="">Choose a project</option>
      {projects.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
    </Select>{' '}
    <label htmlFor="claude-project-backend">Claude backend</label>{' '}
    <Select id="claude-project-backend" value={project?.claudeBackend ?? ''} disabled={!online || !project || busy} onChange={(e) => void save(e.target.value)}>
      <option value="">Use host default</option>
      <option value="sdk">Claude SDK</option>
      <option value="cli">Claude CLI</option>
    </Select>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </div>
}
