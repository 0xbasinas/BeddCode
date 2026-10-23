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

### Run the desktop app without a terminal for the host

```bash
pnpm build
pnpm --filter @beddcode/desktop start
```

The app starts its own local host, restarts it if it stops, and stops it when you quit; if a host is already running on the port (for example from `pnpm dev`) it uses that one. The host serves the built web app, so the window loads it from `http://127.0.0.1:3773` and a browser on this machine (or the tailnet, with a paired device) can open the same address. The host's log is in the app's data folder under `logs/host.log`. `BEDDCODE_NO_DAEMON=1` turns the supervision off.

### Build installers

Build on the operating system you are building for; the host's native terminal library is installed per platform.

```bash
pnpm dist:win     # Windows: apps/desktop/release/BeddCode-Setup-<version>.exe
pnpm dist:linux   # Linux: apps/desktop/release/BeddCode-<version>-x64.AppImage and .deb
```

This builds the web app, bundles the host (`apps/desktop/scripts/build-host.mjs`: one script plus the native terminal library and the Claude SDK, about 70 MB) and wraps everything with electron-builder (`apps/desktop/electron-builder.yml`). The installed app runs the host with its own runtime, so Node does not need to be installed. Agent CLIs (`claude`, `codex`, `grok`) still have to be installed and signed in on the machine.

- The Windows installer and Linux AppImage update themselves from GitHub releases (a .deb is updated by the package manager). `BEDDCODE_NO_UPDATE=1` turns it off.
- To sign the Windows installer, set `CSC_LINK` and `CSC_KEY_PASSWORD` when building. Unsigned builds work, but Windows warns on first run.
- Pushing a tag such as `v0.2.0` runs `.github/workflows/release.yml`, which builds both installers and attaches them to a draft release. `.github/workflows/ci.yml` checks every push and pull request on Windows and Linux.
- `node scripts/make-icons.mjs` renders every icon from `assets/logo/mark.svg`.

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

- Add folders from the sidebar's **Add folder** menu: Browse… opens the system folder picker in the desktop app (an in-app folder browser, backed by `folders.browse`, on remote hosts and in the plain web app), and recent folders are one click away. Nothing is typed. New sessions can run in the folder itself or in a **worktree** (`<repo>/.wt/<branch>`, ignored by git), so several agents can work in parallel on separate branches.
- Start a session with **No project** to ask questions or work without selecting a folder. These sessions appear together under **No project** on their host. Each uses a persistent folder in BeddCode's data directory, so session files and agent resumes survive restarts. Pick a folder in the composer, or use a project's **+**, to start a project session instead.
- The git pane (changes, commits, pull request) reads the selected folder live through your own `git`, including before a conversation starts. Pull requests use your signed-in GitHub CLI (`gh`); BeddCode never stores a token, and pushing or opening a PR only happens when you click the button.

In **Git → Changes**, select files and click **Generate message** to draft a commit summary and description with Claude Code, Codex, or a configured ACP agent on that host. The themed agent picker chooses which account generates the draft. Edit the result, then choose **Commit** or **Commit & push**. Unselected staged files keep their staging state. Commit/push progress and results stay visible across Git tabs and pane switches. If pushing fails after a successful commit, the app keeps the commit, shows Git's error, and offers **Retry push** without making another commit. The commit count refreshes after the operation completes. A branch without an upstream shows **Publish branch**.

In **Git → PR**, choose a base branch and click **Generate PR draft**. The draft uses committed branch changes, excluding uncommitted files. Review and edit it before clicking **Push & create pull request**. Draft generation also works when GitHub is unavailable; creating the PR requires `gh` authentication. Generation runs separately from the conversation in a temporary folder and supplies the diff as context. Native Claude runs without tools and Codex uses an ephemeral read-only thread. ACP generation advertises no client tools, declines file, terminal and permission requests, and selects a read-only or asking mode when offered. ACP has no universal switch to disable an agent's own tools; reported tool use rejects the draft. The agent must already be signed in and return the requested JSON. Generation closes its process afterward, and closes its provider session when the agent supports that operation.

Git drafts keep the selected model but use lower reasoning settings where supported. Claude draft jobs disable extended thinking; Codex uses an advertised minimal/low effort; ACP agents use a lower reasoning choice when they offer one. Conversation settings are unchanged. Context preparation resolves Git metadata once per batch and reads up to four file diffs concurrently; the stale-change check still runs before returning the draft.

### Panes

Choose a folder and host in the new-session composer, then open Terminal, Files, or Git from the right rail. These tools work without sending a message or starting an agent. Switching folders switches the tools to that folder; terminals and open files stay associated with their original host and folder. Once a conversation starts, its actual working folder is used, including its worktree if one was created.

- **Terminal:** real shells (PowerShell 7 on Windows, `$SHELL` elsewhere) run on the host in the selected folder and survive closing the app; reconnecting replays their recent output.
- **Files:** a lazily loaded tree with search, a CodeMirror editor (Ctrl+S to save, tabs, unsaved-change and changed-on-disk handling), and a file watcher. Paths can never leave the session folder, also through links.
- **Browser:** a small tabbed browser for previewing dev servers. In the desktop app pages open in an isolated `<webview>`; in a plain browser they open in a sandboxed iframe (some sites refuse to be embedded).

Each pane can add context to the current composer's next message, including a new-session draft. New-session attachments stay separate by host and selected folder. In **Files**, click the paperclip beside a file, in search results, or above the open editor to attach its saved contents, including images. In **Terminal**, select text and click the paperclip in the header to attach it with its terminal and project or session details. In **Browser**, click the pointer button, then an element to attach its HTML, selector and page details; the desktop app also includes a cropped screenshot. Press Escape or click the pointer button again to cancel. Picking elements in cross-origin previews requires the desktop app.

Attachments appear as removable chips in the composer and stay with their host and session when you switch chats. Files are copied on the host and limited to 20 MB each. Save editor changes before attaching them. Wait for attachments to finish before sending; remove a failed attachment to continue.

### Workspace preferences

The first-launch checklist helps connect a host and add a project folder. **Ctrl+K** (Cmd+K on macOS) searches sessions by title, folder, branch, or activity. The agent chip below a conversation opens session details, permission choices, repository actions, and local session notes.

Sessions with a default name use the first message as their title. Use the conversation's **… → Rename session** menu to choose a name; it is saved on the host. After a host restart, interrupted turns show **Stopped · ready to continue** and an explanation in the conversation. Send another message to resume. Approval cards show whether a request was allowed, denied, or cancelled, and keep the full command available under **Details**.

**Settings** includes General, Appearance, Shortcuts, Agents, Permissions, Hosts, Git, Editor, and About. Set the default host and workspace type, choose comfortable or compact density, reduce motion, or change editor font size, indentation, wrapping, and line numbers. UI preferences and session notes are saved on this client. Unsaved editor text survives navigating between panes and Settings within the app; use Ctrl+S to write it to the host.

### ACP agents

Open **Settings → Agents** to see the agents on a host. Choose a host, refresh detection after installing or signing in to a CLI, or add an agent from the ACP registry. **Custom agent** accepts an executable, one argument per line, and optional environment variables. Commands run on the selected host; adding one does not start a session. Removing an agent keeps its CLI and existing session history.

Set the default agent, model, reasoning effort, and permission mode from the options that agent reports. Defaults are saved in this app separately for each host and apply to new sessions. Existing sessions keep their choices. Unavailable agents and unsupported saved options fall back to the agent's current defaults.

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) can also be added over the WebSocket API:

- `agents.registry` lists the public ACP registry; `agents.add { registryId }` adds one. npx and uvx agents run at the registry's pinned version. Agents that ship a program (entries with `download`) are downloaded only after the user agrees (`acceptDownload: true`): https only, checked against the registry's SHA-256 when it publishes one, unpacked under `<data dir>/agents/<id>/<version>`, and deleted again when the agent is removed
- `agents.add { label, command, args? }` adds a local command such as `goose acp`
- Added agents live in `<data dir>/acp-agents.json` and show up as providers (`acp:<id>`)

### Working with agents

- **Steering and queueing.** Send a message while an agent works. Claude and Codex take it into the running turn (Claude as a priority "next" message, Codex through `turn/steer`); other agents, or `mode: 'queue'`, keep it in a queue that runs after the turn. Queued messages can be cancelled or sent now, and survive a host restart.
- **Plans and questions.** Claude's plan mode shows the plan for approval (including "approve and auto-accept edits"); to-do lists from Claude, Codex and ACP agents appear as a plan card above the composer. Questions an agent asks (Claude's AskUserQuestion, Codex's request_user_input) become a card with its options.
- **Fork, resume, history.** Fork a session from any finished turn. **Resume an earlier conversation** on the new-session screen lists what an agent keeps on its host, including conversations started in its own CLI, and brings one in as a session. Claude, Codex and ACP agents that list their sessions are supported.
- **Tools & MCP.** Settings → Tools & MCP lists, adds and removes MCP servers by running the agent's own CLI (`claude mcp`, `codex mcp`), so its own config files stay the single source.
- **Commands and skills.** Typing `/` in the composer lists the agent's slash commands and skills (Claude's live list, Codex skills, an ACP agent's available commands).
- **ACP extras.** Agents' own settings (model, reasoning effort, modes, commands) appear in the composer, including on the new-session screen: the host starts the agent once to read them (`agents.preview`) and remembers the answer, so custom commands such as `grok agent stdio` get the same picker as any registry agent. Choices made there are applied as the session starts. Pictures go to agents that accept images; pictures go to agents that accept images; start-up has timeouts and failures include the agent's last stderr line.

## Layout

- `apps/server` – headless host daemon (HTTP `/health`, WebSocket `/ws`)
- `apps/desktop` – Electron shell; starts and supervises the local host, so the app does not need a terminal
- `assets/logo` – the logo; `node scripts/make-icons.mjs` renders every icon from it
- `apps/web` – React UI
- `apps/mobile` – Expo (React Native) app, scaffolded from the SDK 58 template. It uses `packages/contracts` and `packages/client-runtime` directly. `pnpm --filter @beddcode/mobile start` runs the dev server (open it in Expo Go or a dev build; the phone must be on the tailnet to reach a host). Only the shared-package wiring exists so far, not the screens.
- `packages/contracts` – wire and event schemas
- `packages/shared` – logging and async helpers
- `packages/provider-core` – provider adapter interface
- `packages/provider-claude`, `provider-codex` – native adapters; `provider-acp` – generic ACP client (registry agents and local commands)
- `packages/client-runtime` – host connection runtime
