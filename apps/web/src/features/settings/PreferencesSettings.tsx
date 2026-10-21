import { useAppPreferences } from '../../stores/appPreferences.ts'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { Select } from '../../ui/Select.tsx'

export function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange(value: boolean): void
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>{label}</span>
        <small>{description}</small>
      </div>
      <button
        className="settings-toggle"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  )
}

export function PreferencesSettings({
  section,
}: {
  section: 'general' | 'appearance' | 'editor' | 'git' | 'shortcuts'
}) {
  const values = useAppPreferences((s) => s.values)
  const update = useAppPreferences((s) => s.update)
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const heading = {
    general: ['General', 'Defaults for BeddCode on this computer.'],
    appearance: ['Appearance', 'Make BeddCode feel at home on your screen.'],
    editor: ['Editor', 'How files open and appear in the built-in editor.'],
    git: ['Git', 'How agents work with your repositories and branches.'],
    shortcuts: ['Shortcuts', 'Move around BeddCode without reaching for the mouse.'],
  }[section]
  return (
    <>
      <header className="settings-heading">
        <h2>{heading[0]}</h2>
        <p>{heading[1]}</p>
      </header>
      {section === 'general' && (
        <>
          <div className="settings-section-head">
            <h3>New sessions</h3>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <label className="setting-label" htmlFor="default-host">
                <span>Default host</span>
                <small>Where new sessions start.</small>
              </label>
              <Select
                id="default-host"
                aria-label="Default host"
                value={
                  entries.some((e) => e.key === values.defaultHostKey)
                    ? values.defaultHostKey
                    : LOCAL_HOST_KEY
                }
                onChange={(e) => update({ defaultHostKey: e.target.value })}
              >
                {entries.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.key === LOCAL_HOST_KEY
                      ? 'This PC'
                      : (runtimes[entry.key]?.host?.name ?? entry.name)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="setting-row">
              <div className="setting-label">
                <span>Agent logins and session history</span>
                <small>
                  Each host keeps its own agent logins, folders, and conversation history. Your app
                  reconnects to paired hosts on launch.
                </small>
              </div>
            </div>
          </div>
        </>
      )}
      {section === 'appearance' && (
        <>
          <div className="settings-section-head">
            <h3>Interface</h3>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <label className="setting-label" htmlFor="interface-font">
                <span>Interface font</span>
                <small>The font used for labels, menus, and conversation text.</small>
              </label>
              <Select
                id="interface-font"
                aria-label="Interface font"
                value={values.uiFont}
                onChange={(e) => update({ uiFont: e.target.value as 'inter' | 'system' })}
              >
                <option value="inter">Inter</option>
                <option value="system">System font</option>
              </Select>
            </div>
            <div className="setting-row">
              <div className="setting-label">
                <span>Density</span>
                <small>Spacing in session lists, file trees, and Settings.</small>
              </div>
              <div className="settings-segmented" role="group" aria-label="Interface density">
                {(['comfortable', 'compact'] as const).map((density) => (
                  <button
                    key={density}
                    aria-pressed={values.density === density}
                    onClick={() => update({ density })}
                  >
                    {density === 'comfortable' ? 'Comfortable' : 'Compact'}
                  </button>
                ))}
              </div>
            </div>
            <Toggle
              label="Reduce motion"
              description="Keep pane and menu transitions still."
              checked={values.reduceMotion}
              onChange={(reduceMotion) => update({ reduceMotion })}
            />
          </div>
        </>
      )}
      {section === 'editor' && (
        <>
          <div className="settings-section-head">
            <h3>Text</h3>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <label className="setting-label" htmlFor="editor-font-size">
                <span>Font size</span>
                <small>JetBrains Mono in the built-in editor.</small>
              </label>
              <Select
                id="editor-font-size"
                aria-label="Editor font size"
                value={values.editorFontSize}
                onChange={(e) => update({ editorFontSize: Number(e.target.value) })}
              >
                {Array.from({ length: 11 }, (_, i) => i + 10).map((size) => (
                  <option key={size} value={size}>
                    {size} px
                  </option>
                ))}
              </Select>
            </div>
            <div className="setting-row">
              <label className="setting-label" htmlFor="editor-tab-size">
                <span>Tab size</span>
                <small>Width of a tab character in the editor.</small>
              </label>
              <Select
                id="editor-tab-size"
                aria-label="Editor tab size"
                value={values.editorTabSize}
                onChange={(e) => update({ editorTabSize: Number(e.target.value) as 2 | 4 })}
              >
                <option value={2}>2 spaces</option>
                <option value={4}>4 spaces</option>
              </Select>
            </div>
            <Toggle
              label="Line numbers"
              description="Show a line number beside the code."
              checked={values.editorLineNumbers}
              onChange={(editorLineNumbers) => update({ editorLineNumbers })}
            />
            <Toggle
              label="Word wrap"
              description="Wrap long lines to fit the editor width."
              checked={values.editorWordWrap}
              onChange={(editorWordWrap) => update({ editorWordWrap })}
            />
          </div>
          <p className="settings-footnote">Files save when you press Ctrl+S or click Save.</p>
        </>
      )}
      {section === 'git' && (
        <>
          <div className="settings-section-head">
            <h3>Worktrees</h3>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <label className="setting-label" htmlFor="default-workspace">
                <span>Default workspace</span>
                <small>You can choose another workspace before starting each session.</small>
              </label>
              <Select
                id="default-workspace"
                aria-label="Default workspace"
                value={values.defaultWorkspace}
                onChange={(e) =>
                  update({ defaultWorkspace: e.target.value as 'worktree' | 'local' })
                }
              >
                <option value="worktree">New worktree</option>
                <option value="local">Main checkout</option>
              </Select>
            </div>
            <div className="setting-row">
              <div className="setting-label">
                <span>Isolated branches</span>
                <small>
                  A new worktree keeps an agent's edits apart from your main checkout. Folders
                  without a Git repository use the folder directly.
                </small>
              </div>
            </div>
          </div>
          <div className="settings-section-head">
            <h3>Commits and pull requests</h3>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-label">
                <span>Your Git identity and GitHub CLI</span>
                <small>
                  Commits use the host's Git configuration. Pull requests use its signed-in GitHub
                  CLI. Pushes and commits run when you click their buttons.
                </small>
              </div>
            </div>
          </div>
        </>
      )}
      {section === 'shortcuts' && (
        <div className="settings-card shortcut-list">
          {[
            ['Search sessions', ['Ctrl', 'K']],
            ['Send a message', ['Enter']],
            ['New line in a message', ['Shift', 'Enter']],
            ['Save the current file', ['Ctrl', 'S']],
            ['Allow the current approval, when not typing', ['Enter']],
            ['Deny the current approval, when not typing', ['Esc']],
            ['Close a menu or dialog', ['Esc']],
          ].map(([label, keys]) => (
            <div className="setting-row" key={String(label)}>
              <span className="setting-label">{label}</span>
              <span className="shortcut-keys">
                {(keys as string[]).map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
