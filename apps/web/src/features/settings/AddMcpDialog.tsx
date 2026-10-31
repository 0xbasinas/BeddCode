import { Select } from '../../ui/Select.tsx'
import { Button } from '@/components/ui/button'
import { useEffect, useRef } from 'react'
import { Globe, Terminal, X } from 'lucide-react'
import type { McpForm } from './mcpForm.ts'

export function AddMcpDialog({
  agent,
  kind,
  form,
  setForm,
  busy,
  error,
  onAdd,
  onClose,
}: {
  agent: string
  kind: string
  form: McpForm
  setForm(form: McpForm): void
  busy: boolean
  error?: string
  onAdd(): void
  onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement
    element.showModal()
    return () => {
      element.close()
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])
  const remote = form.kind !== 'stdio'
  const loginName = /^[\w.-]+$/.test(form.name.trim()) ? form.name.trim() : 'SERVER_NAME'
  return (
    <dialog
      ref={dialog}
      className="agent-dialog mcp-dialog"
      aria-labelledby="add-mcp-heading"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) onAdd()
        }}
      >
        <header className="agent-dialog-head">
          <div>
            <h2 id="add-mcp-heading">Add MCP server</h2>
            <p>Connect a tool server to {agent} on this host.</p>
          </div>
          <Button
            variant="app"
            type="button"
            className="icon-btn"
            aria-label="Close add server"
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </Button>
        </header>
        <div className="agent-dialog-body mcp-dialog-body">
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          <fieldset className="mcp-kind">
            <legend>Connection type</legend>
            <button
              type="button"
              className={remote ? '' : 'selected'}
              aria-pressed={!remote}
              disabled={busy}
              onClick={() => setForm({ ...form, kind: 'stdio' })}
            >
              <Terminal size={17} />
              <span>
                <strong>Local command</strong>
                <small>Runs on this host</small>
              </span>
            </button>
            <button
              type="button"
              className={remote ? 'selected' : ''}
              aria-pressed={remote}
              disabled={busy}
              onClick={() => setForm({ ...form, kind: 'http' })}
            >
              <Globe size={17} />
              <span>
                <strong>Remote server</strong>
                <small>Connects to a URL</small>
              </span>
            </button>
          </fieldset>
          <div className="mcp-form-fields">
            <label htmlFor="mcp-name">
              Server name <small>Letters, numbers, dots, dashes or underscores.</small>
            </label>
            <input
              id="mcp-name"
              autoFocus
              value={form.name}
              placeholder="e.g. beddcode"
              autoComplete="off"
              disabled={busy}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            {remote ? (
              <>
                <label htmlFor="mcp-url">
                  Server URL <small>The HTTPS address ending in /mcp for most servers.</small>
                </label>
                <input
                  id="mcp-url"
                  type="url"
                  value={form.url}
                  placeholder="https://example.com/mcp"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                />
                {kind === 'claude' && (
                  <>
                    <label htmlFor="mcp-transport">Transport</label>
                    <Select
                      id="mcp-transport"
                      value={form.kind}
                      disabled={busy}
                      onChange={(e) => setForm({ ...form, kind: e.target.value as 'http' | 'sse' })}
                    >
                      <option value="http">HTTP (recommended)</option>
                      <option value="sse">SSE (legacy)</option>
                    </Select>
                  </>
                )}
                <div className="mcp-auth-note">
                  <strong>Authentication</strong>
                  <p>
                    Add the server first. If it requires OAuth, finish sign-in in {agent}. BeddCode
                    does not start the sign-in flow here.
                  </p>
                  {kind === 'codex' && (
                    <p>
                      In a terminal on this host, run <code>codex mcp login {loginName}</code>.
                    </p>
                  )}
                  {kind === 'claude' && (
                    <p>
                      Open Claude Code on this host and use <code>/mcp</code> to sign in.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <label htmlFor="mcp-command">
                  Command <small>The executable that starts the server.</small>
                </label>
                <input
                  id="mcp-command"
                  value={form.command}
                  placeholder="e.g. npx"
                  autoComplete="off"
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                />
                <label htmlFor="mcp-args">
                  Arguments <small>One argument per line.</small>
                </label>
                <textarea
                  id="mcp-args"
                  rows={3}
                  value={form.args}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                />
                <label htmlFor="mcp-env">
                  Environment variables{' '}
                  <small>
                    Optional. Use NAME=value, one per line. Saved in the agent’s configuration.
                  </small>
                </label>
                <textarea
                  id="mcp-env"
                  rows={2}
                  value={form.env}
                  placeholder="API_KEY=…"
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, env: e.target.value })}
                />
              </>
            )}
            {kind === 'claude' && (
              <>
                <label htmlFor="mcp-scope">
                  Available in <small>Choose where Claude Code saves this server.</small>
                </label>
                <Select
                  id="mcp-scope"
                  value={form.scope ?? 'user'}
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, scope: e.target.value as McpForm['scope'] })}
                >
                  <option value="user">All my projects</option>
                  <option value="project">This project (shared via .mcp.json)</option>
                  <option value="local">This project, only for me</option>
                </Select>
              </>
            )}
          </div>
        </div>
        <footer className="agent-dialog-foot">
          <Button
            variant="app"
            type="button"
            className="settings-button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button variant="app" className="settings-button primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add server'}
          </Button>
        </footer>
      </form>
    </dialog>
  )
}
