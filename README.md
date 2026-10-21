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

The server uses Node's file watcher with the `tsx` TypeScript loader. Electron waits for both the host's `/health` endpoint and the web UI port before opening, with a 30-second startup timeout. If startup fails, inspect the server output in that terminal. To start the host separately, run `pnpm --filter @beddcode/server start`; the UI reconnects automatically when it becomes available.

### Server environment

- `BEDDCODE_PORT` (default 3773), `BEDDCODE_HOST` (default 127.0.0.1), `BEDDCODE_HOME` (data dir, default `~/.beddcode`)
- `BEDDCODE_FAKE_PROVIDER=1` also registers the scripted fake agent (no CLI or login needed). In PowerShell, run `$env:BEDDCODE_FAKE_PROVIDER = "1"` before `pnpm dev`.
- Claude Code and Codex are detected on PATH; each uses your existing CLI login and settings (`claude auth login`, `codex login`)

### Remote hosts

Each machine runs its own host daemon and keeps its own agent logins, projects, files, and session history. Connect both machines to the same Tailscale tailnet, install Node 22+ and pnpm, and run `pnpm install` in a checkout on the remote machine.

From that checkout, start the host in the foreground:

```bash
pnpm --filter @beddcode/server start serve --host 0.0.0.0
```

Or install it to start at login, using a Windows scheduled task or a Linux systemd user service:

```bash
pnpm --filter @beddcode/server start install-service
pnpm --filter @beddcode/server start pair
```

The `pair` command prints a six-digit code valid for ten minutes and one use. In the desktop app, open **Hosts**, choose a discovered machine or enter its address, and enter the code. Select that host in the new-session composer. Sessions from every connected host appear in the sidebar, grouped by host and project. Each session's terminal, files, Git operations, and attachments use that session's host.

The client remembers paired hosts and tries their MagicDNS name and IP in order. It reconnects after a network interruption and replays missed conversation events. A stalled handshake times out after five seconds; heartbeats detect silent disconnects. New routes must report the paired host's original ID.

To revoke access to this machine, open **Hosts → Paired devices** on this machine and revoke the device. Its active connections close immediately and its token stops working. Removing a remote host from a client's list only forgets that client's saved connection.

Useful options and troubleshooting:

- Use `--port 4000` with both `serve` or `install-service` and `pair` for a custom port. Enter that port in the app's host address.
- The default network guard accepts loopback and Tailscale address ranges. `--allow-lan` also accepts private LAN addresses; remote devices still need pairing. The daemon does not configure Tailscale or firewall rules.
- `--require-token` requires a paired token even on loopback. The app's built-in local connection assumes the default loopback trust.
- For a browser UI served from another origin, add that exact origin with `--allow-origin <origin>` on the host. Local development origins are accepted by default. HTTPS/WSS termination is not configured by the daemon; enter a plain hostname, `http://`, or `ws://` address.
- Linux users can inspect logs with `journalctl --user -u beddcode-server -f`. To keep the user service running after logout, use `loginctl enable-linger "$USER"`.
- Keep the checkout and its dependencies in place while the service uses them. Run `pnpm --filter @beddcode/server start uninstall-service` to stop and remove it. `--dry-run` previews either service command without changing the machine.
- Remote browser previews need a URL reachable from the client, such as the remote host's tailnet address. `localhost` in the browser pane refers to the client machine.

### Projects, worktrees and git

- Add folders with `projects.add` (the sidebar's add-folder button). New sessions can run in the folder itself or in a **worktree** (`<repo>/.wt/<branch>`, ignored by git), so several agents can work in parallel on separate branches.
- The git pane (changes, commits, pull request) reads the session's folder live through your own `git`. Pull requests use your signed-in GitHub CLI (`gh`); BeddCode never stores a token, and pushing or opening a PR only happens when you click the button.

### Panes

- **Terminal:** real shells (PowerShell 7 on Windows, `$SHELL` elsewhere) run on the host in the session's folder and survive closing the app; reconnecting replays their recent output.
- **Files:** a lazily loaded tree with search, a CodeMirror editor (Ctrl+S to save, tabs, unsaved-change and changed-on-disk handling), and a file watcher. Paths can never leave the session folder, also through links.
- **Browser:** a small tabbed browser for previewing dev servers. In the desktop app pages open in an isolated `<webview>`; in a plain browser they open in a sandboxed iframe (some sites refuse to be embedded).

### Workspace preferences

The first-launch checklist helps connect a host and add a project folder. **Ctrl+K** (Cmd+K on macOS) searches sessions by title, folder, branch, or activity. The agent chip below a conversation opens session details, permission choices, repository actions, and local session notes.

Sessions with a default name use the first message as their title. Use the conversation's **… → Rename session** menu to choose a name; it is saved on the host. After a host restart, interrupted turns show **Stopped · ready to continue** and an explanation in the conversation. Send another message to resume. Approval cards show whether a request was allowed, denied, or cancelled, and keep the full command available under **Details**.

**Settings** includes General, Appearance, Shortcuts, Agents, Permissions, Hosts, Git, Editor, and About. Set the default host and workspace type, choose comfortable or compact density, reduce motion, or change editor font size, indentation, wrapping, and line numbers. UI preferences and session notes are saved on this client. Unsaved editor text survives navigating between panes and Settings within the app; use Ctrl+S to write it to the host.

### ACP agents

Open **Settings → Agents** to see the agents on a host. Choose a host, refresh detection after installing or signing in to a CLI, or add an agent from the ACP registry. **Custom agent** accepts an executable, one argument per line, and optional environment variables. Commands run on the selected host; adding one does not start a session. Removing an agent keeps its CLI and existing session history.

Set the default agent, model, reasoning effort, and permission mode from the options that agent reports. Defaults are saved in this app separately for each host and apply to new sessions. Existing sessions keep their choices. Unavailable agents and unsupported saved options fall back to the agent's current defaults.

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) can also be added over the WebSocket API:

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
