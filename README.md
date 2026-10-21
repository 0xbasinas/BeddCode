# BeddCode

A desktop workspace for running coding agents (Claude Code, Codex, and ACP-compatible CLIs) on local and remote hosts. See [docs/PLAN.md](docs/PLAN.md) for the architecture and roadmap, and `ui-docs/` for the designs.

## Develop

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev        # server (127.0.0.1:3773), web (localhost:5173) and the Electron window
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt:check
```

### Server environment

- `BEDDCODE_PORT` (default 3773), `BEDDCODE_HOST` (default 127.0.0.1), `BEDDCODE_HOME` (data dir, default `~/.beddcode`)
- `BEDDCODE_FAKE_PROVIDER=1` also registers the scripted fake agent (no CLI or login needed)
- Claude Code and Codex are detected on PATH; each uses your existing CLI login and settings (`claude auth login`, `codex login`)

### Projects, worktrees and git

- Add folders with `projects.add` (the sidebar's add-folder button). New sessions can run in the folder itself or in a **worktree** (`<repo>/.wt/<branch>`, ignored by git), so several agents can work in parallel on separate branches.
- The git pane (changes, commits, pull request) reads the session's folder live through your own `git`. Pull requests use your signed-in GitHub CLI (`gh`); BeddCode never stores a token, and pushing or opening a PR only happens when you click the button.

### Panes

- **Terminal:** real shells (PowerShell 7 on Windows, `$SHELL` elsewhere) run on the host in the session's folder and survive closing the app; reconnecting replays their recent output.
- **Files:** a lazily loaded tree with search, a CodeMirror editor (Ctrl+S to save, tabs, unsaved-change and changed-on-disk handling), and a file watcher. Paths can never leave the session folder, also through links.
- **Browser:** a small tabbed browser for previewing dev servers. In the desktop app pages open in an isolated `<webview>`; in a plain browser they open in a sandboxed iframe (some sites refuse to be embedded).

### ACP agents

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) can be added over the WebSocket API (a settings screen comes in phase 9):

- `agents.registry` lists the public ACP registry; `agents.add { registryId }` adds one (npx and uvx agents run at the registry's pinned version; binary-only agents are not supported yet)
- `agents.add { label, command, args? }` adds a local command such as `goose acp`
- Added agents live in `<data dir>/acp-agents.json` and show up as providers (`acp:<id>`)

## Layout

- `apps/server` – headless host daemon (HTTP `/health`, WebSocket `/ws`)
- `apps/web` – React UI
- `apps/desktop` – Electron shell
- `packages/contracts` – wire and event schemas
- `packages/shared` – logging and async helpers
- `packages/provider-core` – provider adapter interface
- `packages/provider-claude`, `provider-codex` – native adapters; `provider-acp` – generic ACP client (registry agents and local commands)
- `packages/client-runtime` – host connection runtime
