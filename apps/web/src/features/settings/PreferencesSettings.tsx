import { useAppPreferences } from '../../stores/appPreferences.ts'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { Select } from '../../ui/Select.tsx'

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange(value: boolean): void
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>{label}</span>
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
    general: 'General',
    appearance: 'Appearance',
    editor: 'Editor',
    git: 'Git',
    shortcuts: 'Shortcuts',
  }[section]
  return (
    <>
      <header className="settings-heading">
        <h2>{heading}</h2>
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
          </div>
          <div className="settings-section-head">
            <h3>Sessions</h3>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <label className="setting-label" htmlFor="slow-turn">
                <span>Warn when a turn runs long</span>
              </label>
              <Select
                id="slow-turn"
                aria-label="Warn when a turn runs long"
                value={String(values.slowTurnMinutes)}
                onChange={(e) => update({ slowTurnMinutes: Number(e.target.value) })}
              >
                <option value="0">Off</option>
                <option value="5">After 5 minutes</option>
                <option value="10">After 10 minutes</option>
                <option value="30">After 30 minutes</option>
              </Select>
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
              <div className="setting-label">
                <span>Theme</span>
              </div>
              <div className="settings-segmented" role="group" aria-label="Color theme">
                {(['system', 'dark', 'light'] as const).map((theme) => (
                  <button
                    key={theme}
                    aria-pressed={values.theme === theme}
                    onClick={() => update({ theme })}
                  >
                    {theme === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light'}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <label className="setting-label" htmlFor="interface-font">
                <span>Interface font</span>
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
              checked={values.editorLineNumbers}
              onChange={(editorLineNumbers) => update({ editorLineNumbers })}
            />
            <Toggle
              label="Word wrap"
              checked={values.editorWordWrap}
              onChange={(editorWordWrap) => update({ editorWordWrap })}
            />
          </div>
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
          </div>
        </>
      )}
      {section === 'shortcuts' && (
        <div className="settings-card shortcut-list">
          {[
            ['Command palette', ['Ctrl', 'Shift', 'P']],
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
