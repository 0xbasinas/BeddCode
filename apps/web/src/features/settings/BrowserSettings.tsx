import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ExternalLink, Plus, Puzzle, Trash2 } from 'lucide-react'
import type { BrowserExtension, BrowserProfile, InstalledBrowser } from '@beddcode/contracts'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { Select } from '../../ui/Select.tsx'
import type { DesktopBrowser } from '../../ui/desktop.ts'

const PROJECT_STORAGE_KEY = 'beddcode.browser-settings.project'

interface BrowserProject {
  path: string
  name: string
  host: string
}

interface ProjectBrowserSettings {
  profiles: BrowserProfile[]
  activeId: string
  browserId?: string
  extensions: BrowserExtension[]
}

function readSavedProject(): string {
  try {
    return localStorage.getItem(PROJECT_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BrowserSettings() {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const browser = typeof window === 'undefined' ? undefined : window.beddcodeDesktop?.browser
  const projects = useMemo(() => {
    const byPath = new Map<string, BrowserProject>()
    for (const entry of entries) {
      const hostName =
        entry.key === LOCAL_HOST_KEY ? 'This PC' : (runtimes[entry.key]?.host?.name ?? entry.name)
      for (const project of runtimes[entry.key]?.projects ?? []) {
        if (!byPath.has(project.path))
          byPath.set(project.path, { path: project.path, name: project.name, host: hostName })
      }
    }
    return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [entries, runtimes])
  const [projectPath, setProjectPath] = useState(readSavedProject)
  const [installed, setInstalled] = useState<InstalledBrowser[]>([])
  const [data, setData] = useState<ProjectBrowserSettings>()
  const [sourceBrowser, setSourceBrowser] = useState('manual')
  const [profileName, setProfileName] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    if (!projects.length) return
    if (!projects.some((project) => project.path === projectPath)) setProjectPath(projects[0]!.path)
  }, [projectPath, projects])

  useEffect(() => {
    try {
      if (projectPath) localStorage.setItem(PROJECT_STORAGE_KEY, projectPath)
    } catch {
      // Browser settings still persist in the desktop process if local storage is unavailable.
    }
  }, [projectPath])

  useEffect(() => {
    if (!browser) return
    let live = true
    void browser.installedBrowsers().then((list) => live && setInstalled(list))
    return () => {
      live = false
    }
  }, [browser])

  useEffect(() => {
    let live = true
    if (!browser || !projectPath) {
      setData(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    void browser
      .profiles(projectPath)
      .then(
        (next) => live && setData(next),
        (cause: unknown) => live && setError(errorText(cause)),
      )
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [browser, projectPath])

  const updateProfiles = (profiles: BrowserProfile[]) =>
    setData((current) => (current ? { ...current, profiles } : current))
  const updateExtensions = (extensions: BrowserExtension[]) =>
    setData((current) => (current ? { ...current, extensions } : current))

  const run = async (action: (api: DesktopBrowser) => Promise<unknown>) => {
    if (!browser) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await action(browser)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const selectProfile = async (profileId: string) => {
    if (!browser || !projectPath || !(await browser.selectProfile(projectPath, profileId))) return
    setData((current) => (current ? { ...current, activeId: profileId } : current))
  }

  const createProfile = async () => {
    const name = profileName.trim()
    if (!browser || !projectPath || !name) return
    await run(async (api) => {
      const profiles = await api.createProfile(projectPath, name, false)
      if (!Array.isArray(profiles)) throw new Error('Could not create the browser profile.')
      updateProfiles(profiles)
      setProfileName('')
    })
  }

  const setAgentAccess = async (profile: BrowserProfile, allowed: boolean) => {
    if (!browser || !projectPath) return
    await run(async (api) => {
      const profiles = await api.setProfileAgentAccess(projectPath, profile.id, allowed)
      if (Array.isArray(profiles)) updateProfiles(profiles)
      else throw new Error('Could not update agent access for this profile.')
    })
  }

  const setDefaultBrowser = async (browserId: string) => {
    if (!browser || !projectPath) return
    await run(async (api) => {
      if (!(await api.setDefaultBrowser(projectPath, browserId)))
        throw new Error('Could not save the default browser.')
      setData((current) => (current ? { ...current, browserId } : current))
    })
  }

  const importExtensions = async () => {
    if (!browser || !data || !projectPath) return
    await run(async (api) => {
      const result = await api.importExtensions(projectPath, data.activeId, sourceBrowser)
      if (!result) return
      updateExtensions(result.extensions)
      setNotice(
        `Imported ${result.imported} extension${result.imported === 1 ? '' : 's'}${result.extensionsWithSavedData ? ` with saved data for ${result.extensionsWithSavedData}` : ''}${result.skipped ? `; skipped ${result.skipped}` : ''}.`,
      )
    })
  }

  const setEnabled = async (extension: BrowserExtension, enabled: boolean) => {
    if (!browser || !projectPath || !data) return
    await run(async (api) => {
      const extensions = await api.setExtensionEnabled(
        projectPath,
        data.activeId,
        extension.key,
        enabled,
      )
      if (!extensions)
        throw new Error(`Could not ${enabled ? 'enable' : 'disable'} ${extension.name}.`)
      updateExtensions(extensions)
    })
  }

  const removeExtension = async (extension: BrowserExtension) => {
    if (!browser || !projectPath || !data) return
    await run(async (api) => {
      const extensions = await api.removeExtension(projectPath, data.activeId, extension.key)
      if (!extensions) throw new Error(`Could not remove ${extension.name}.`)
      updateExtensions(extensions)
    })
  }

  const openExtensionSettings = async (extension: BrowserExtension) => {
    if (!browser || !projectPath || !data) return
    await run(async (api) => {
      if (!(await api.openExtension(projectPath, data.activeId, extension.key, 'settings')))
        throw new Error(`Could not open ${extension.name}'s settings.`)
    })
  }

  const selectedProject = projects.find((project) => project.path === projectPath)
  const activeProfile = data?.profiles.find((profile) => profile.id === data.activeId)

  return (
    <>
      <header className="settings-heading">
        <h2>Browser</h2>
        <p>
          Choose project browser profiles, extensions, and the browser used for links. Your choices
          are saved on this device.
        </p>
      </header>
      {!browser ? (
        <div className="settings-card">
          <p className="settings-inline-note">
            Browser profile settings are available in the BeddCode desktop app.
          </p>
        </div>
      ) : (
        <>
          <div className="settings-card">
            <div className="setting-row">
              <label className="setting-label" htmlFor="browser-settings-project">
                <span>Project</span>
                <small>Each project keeps its own browser profiles and extensions.</small>
              </label>
              <Select
                id="browser-settings-project"
                aria-label="Browser settings project"
                value={projectPath}
                disabled={!projects.length}
                onChange={(event) => setProjectPath(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.path} value={project.path}>
                    {project.name} · {project.host}
                  </option>
                ))}
              </Select>
            </div>
            {selectedProject && (
              <div className="setting-row browser-project-path">
                <div className="setting-label">
                  <span>Project folder</span>
                </div>
                <code title={selectedProject.path}>{selectedProject.path}</code>
              </div>
            )}
          </div>

          {projects.length === 0 ? (
            <div className="settings-card">
              <p className="settings-inline-note">
                Add a project in the workspace first, then its browser preferences will appear here.
              </p>
            </div>
          ) : loading ? (
            <p className="muted" role="status">
              Loading browser preferences…
            </p>
          ) : data ? (
            <>
              <div className="settings-section-head">
                <h3>Defaults</h3>
              </div>
              <div className="settings-card">
                <div className="setting-row">
                  <label className="setting-label" htmlFor="browser-default-profile">
                    <span>Default profile</span>
                    <small>Used whenever this project opens its Browser pane.</small>
                  </label>
                  <Select
                    id="browser-default-profile"
                    aria-label="Default browser profile"
                    value={data.activeId}
                    disabled={busy}
                    onChange={(event) => void selectProfile(event.target.value)}
                  >
                    {data.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="setting-row">
                  <label className="setting-label" htmlFor="browser-default-app">
                    <span>Open links in</span>
                    <small>Used by the project’s “Open in browser” action.</small>
                  </label>
                  <Select
                    id="browser-default-app"
                    aria-label="Default external browser"
                    value={data.browserId ?? 'system'}
                    disabled={busy}
                    onChange={(event) => void setDefaultBrowser(event.target.value)}
                  >
                    <option value="system">System default</option>
                    {installed.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="settings-section-head">
                <h3>Profiles</h3>
              </div>
              <div className="settings-card">
                {data.profiles.map((profile) => (
                  <div className="setting-row browser-profile-setting" key={profile.id}>
                    <div className="setting-label">
                      <span>
                        {profile.name}
                        {profile.id === data.activeId ? ' · Default' : ''}
                      </span>
                      <small>
                        Agent browser tools {profile.agentsAllowed ? 'can use' : 'cannot use'} this
                        profile.
                      </small>
                    </div>
                    <label className="browser-profile-access">
                      <span>Allow agents</span>
                      <Switch
                        aria-label={`Allow agents to use ${profile.name}`}
                        checked={profile.agentsAllowed}
                        disabled={busy}
                        onCheckedChange={(allowed) => void setAgentAccess(profile, allowed)}
                      />
                    </label>
                  </div>
                ))}
                <form
                  className="setting-row browser-profile-create"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void createProfile()
                  }}
                >
                  <input
                    aria-label="New browser profile name"
                    placeholder="New profile name"
                    maxLength={60}
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                  />
                  <Button type="submit" variant="outline" disabled={busy || !profileName.trim()}>
                    <Plus size={15} /> Add profile
                  </Button>
                </form>
              </div>

              <div className="settings-section-head">
                <h3>Extensions · {activeProfile?.name ?? 'Default'}</h3>
                <div className="settings-actions">
                  <Select
                    aria-label="Import extensions from browser"
                    value={sourceBrowser}
                    disabled={busy}
                    onChange={(event) => setSourceBrowser(event.target.value)}
                  >
                    <option value="manual">Choose folder…</option>
                    {installed.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                  <Button variant="outline" disabled={busy} onClick={() => void importExtensions()}>
                    <Puzzle size={15} /> Import
                  </Button>
                </div>
              </div>
              <div className="settings-card browser-extension-settings">
                {data.extensions.length === 0 ? (
                  <p className="settings-inline-note">No extensions in this profile yet.</p>
                ) : (
                  data.extensions.map((extension) => (
                    <div className="setting-row" key={extension.key}>
                      <div className="setting-label">
                        <span>{extension.name}</span>
                        <small>{extension.enabled === false ? 'Disabled' : 'Enabled'}</small>
                      </div>
                      <Switch
                        aria-label={`Enable ${extension.name}`}
                        checked={extension.enabled !== false}
                        disabled={busy}
                        onCheckedChange={(enabled) => void setEnabled(extension, enabled)}
                      />
                      {extension.hasOptions && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Open ${extension.name} settings`}
                          title="Extension settings"
                          disabled={busy}
                          onClick={() => void openExtensionSettings(extension)}
                        >
                          <ExternalLink size={15} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${extension.name}`}
                        title="Remove extension"
                        disabled={busy}
                        onClick={() => void removeExtension(extension)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : null}
          {(error || notice) && (
            <p
              className={error ? 'browser-settings-error' : 'browser-settings-notice'}
              role="status"
            >
              {error ?? notice}
            </p>
          )}
        </>
      )}
    </>
  )
}
