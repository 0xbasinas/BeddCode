# BeddCode

A desktop workspace for running coding agents (Claude Code, Codex, and ACP-compatible CLIs) on local and remote hosts. See [docs/PLAN.md](docs/PLAN.md) for the architecture and roadmap, and `ui-docs/` for the designs.

## Install

Download the installer for your system from the [latest release](https://github.com/0xbasinas/BeddCode/releases/latest): `BeddCode-Setup-<version>.exe` for Windows, or the `.AppImage` / `.deb` for Linux. Windows builds are not code-signed yet, so SmartScreen may warn on first run. The app updates itself from GitHub releases.

On Windows, the package is also being added to [winget](https://learn.microsoft.com/windows/package-manager/) as `BeddCode.BeddCode`. Once the [submission](https://github.com/microsoft/winget-pkgs/pull/460891) is merged, `winget install BeddCode.BeddCode` will work; `packaging/winget/` holds the manifests and the steps (see its README).

The agent CLIs (`claude`, `codex`, `grok`, …) aren't bundled. Install them and sign in on every machine that runs sessions.

### The `beddcode` command

The installed app also gives you a `beddcode` command, so a terminal is enough to look after a host. It runs on the app's own runtime; nothing else has to be installed.

```bash
# Sessions
beddcode ls                  # sessions on this host (--all, --status needs-you, --json)
beddcode run "fix the tests" # start a session in this folder (--agent, --model, --mode, --worktree)
beddcode run --wait "..."    # stream the answer; exit 0 done, 1 error, 2 stopped, 3 needs you
git diff | beddcode run --wait "review this"   # piped input is added to the prompt
beddcode attach last         # watch a session live, answer approvals, type to steer
beddcode send last "also add a test"           # (--queue to run it after the current turn)
beddcode stop last           # interrupt the running turn
beddcode approve last        # answer what the agent is waiting on (allow | deny | a number)
beddcode undo last           # put back what the latest turn changed

# Automation
beddcode schedule add "every 30m" "check the build"   # or a cron: "0 9 * * 1-5" (ls, runs, run, pause, resume, rm)
beddcode projects add .      # add this folder to BeddCode;  beddcode open . also opens the app
beddcode alert test          # send a test phone alert
beddcode hosts add <address> <code>   # talk to another machine's host; then pass --host <name>

# This machine
beddcode status              # is the host on this machine running, and which version
beddcode doctor              # check git, agent CLIs, GitHub, Tailscale and the host; says how to fix each
beddcode pair                # a one-time code to pair a phone or another computer
beddcode devices             # paired devices;  beddcode revoke <device> removes one
beddcode config set allow-lan on   # the host's settings, kept in its data folder (get, unset)
beddcode logs -f --level warn      # the host's log (-n <lines>, -f to follow, --level)
beddcode report              # a file with doctor output, versions and the recent log, secrets removed
beddcode update              # is there a newer release? (--download fetches the installer)
beddcode completion bash     # tab completion: bash, zsh, fish or powershell
beddcode open                # start the desktop app
beddcode serve               # run the host in this terminal
beddcode host install        # run the host in the background at login (host uninstall removes it)
```

A session is named by its id, the start of its id, part of its title, or `last`. Add `--host <name>` to use a host you added with `hosts add`. For tab completion, `eval "$(beddcode completion bash)"` (or `zsh`), `beddcode completion fish > ~/.config/fish/completions/beddcode.fish`, or `beddcode completion powershell | Out-String | Invoke-Expression` in a profile.

`--port <n>` selects another port. On Windows the installer adds the command to your user PATH (open a new terminal after installing); on Linux the `.deb` already puts `beddcode` on PATH, and the AppImage takes the same arguments (`./BeddCode.AppImage status`). With no arguments `beddcode` opens the app on Linux and shows its help on Windows. From a checkout, the same commands run as `pnpm --filter @beddcode/server start <command>`.

#### A host with no desktop

On a Linux server or a spare machine, one line installs just the host and keeps it running in the background (needs curl and tar; Node.js is downloaded for it if the machine has none):

```bash
curl -fsSL https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.sh | sh
beddcode pair        # then pair your phone or another computer with the code it prints
```

It downloads `beddcode-host-linux-x64.tar.gz` from the latest release, unpacks it to `~/.local/share/beddcode-host`, puts `beddcode` in `~/.local/bin` and runs `beddcode host install`. If the machine has no Node.js 22+, it downloads the official Node 22 (checked against nodejs.org's hash) into the same folder; nothing is installed system-wide, and `--own-node` forces that even when Node exists. Pass `--version <tag>`, `--no-service` or `--own-node` after `sh -s --`. Run `sudo loginctl enable-linger "$USER"` so it keeps running after you log out, and install and sign in to an agent CLI (Claude Code, Codex) on that machine; `beddcode doctor` checks.

On Windows, the same without the desktop app, from PowerShell (no administrator rights needed):

```powershell
irm https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.ps1 | iex
beddcode pair        # in a new terminal, so it sees the updated PATH
```

It downloads `beddcode-host-win-x64.zip` from the latest release, unpacks it to `%LOCALAPPDATA%\beddcode-host`, puts `beddcode.cmd` in `%USERPROFILE%\.local\bin` (added to your user PATH) and registers the `BeddCode Server` scheduled task that `beddcode host install` uses, so it starts whenever you sign in; it runs in a hidden window and `beddcode host uninstall` removes it. Node.js works as on Linux (a private Node 22, hash-checked, when there is no Node 22+). For options, run it as a script block: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.ps1))) -Version <tag> -NoService -OwnNode`. `BEDDCODE_PREFIX` and `BEDDCODE_BIN` change the folders, as on Linux. If the desktop app is also installed, run only one host: both use port 3773 and the same scheduled task.

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
- Pushing a tag such as `v0.2.0` runs `.github/workflows/release.yml`, which builds both installers and attaches them to a draft release. Publishing that release runs `.github/workflows/winget.yml`, which opens the update pull request for winget (needs the `WINGET_TOKEN` secret; see `packaging/winget/README.md`). `.github/workflows/ci.yml` checks every push and pull request on Windows and Linux.
- `node scripts/make-icons.mjs` renders every icon from `assets/logo/mark.svg`.

The server uses Node's file watcher with the `tsx` TypeScript loader. Electron waits for both the host's `/health` endpoint and the web UI port before opening, with a 30-second startup timeout. If startup fails, inspect the server output in that terminal. To start the host separately, run `pnpm --filter @beddcode/server start`; the UI reconnects automatically when it becomes available.

### Android app

The `Android` workflow (`.github/workflows/android.yml`) builds the phone app as an APK, so it runs without a dev server. Pushing a tag such as `v0.2.0` attaches `BeddCode-<version>-android.apk` to that release, and **Actions → Android → Run workflow** builds one on demand as a downloadable artifact. Install it by opening the file on the phone and allowing installs from that source.

It is signed with the debug key unless you add the repository secrets `ANDROID_KEYSTORE_BASE64` (your `.jks`, base64-encoded), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Keep using the same key: Android only installs an update over an app signed by the same one. The build is arm64 only. For push alerts, add a Firebase `google-services.json` (at `apps/mobile/google-services.json`, which is gitignored, or as the `GOOGLE_SERVICES_JSON_B64` secret for this workflow), upload the FCM V1 service-account key to Expo/EAS credentials, and set the EAS project id as `EAS_PROJECT_ID` (environment variable or repository variable); without them the phone says why push is unavailable. To build locally, run `pnpm --filter @beddcode/mobile exec expo prebuild --platform android` and then `./gradlew assembleRelease` in `apps/mobile/android` (JDK 17 and the Android SDK).

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
- **Tailscale Serve and other local reverse proxies.** A connection that reaches the host through a proxy on the same machine (it carries `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or `Tailscale-User-*` headers) is judged by the address the proxy reports, not as loopback. Devices behind `tailscale serve` therefore pair first like any other tailnet device, `/admin/pair` and the loopback-only calls refuse them, and Tailscale Funnel requests from the public internet are refused outright.
- `--require-token` requires a paired token even on loopback. The app's built-in local connection assumes the default loopback trust.
- For a browser UI served from another origin, add that exact origin with `--allow-origin <origin>` on the host. Local development origins are accepted by default. HTTPS/WSS termination is not configured by the daemon; enter a plain hostname, `http://`, or `ws://` address.
- Linux users can inspect logs with `journalctl --user -u beddcode-server -f`. To keep the user service running after logout, use `loginctl enable-linger "$USER"`.
- Keep the checkout and its dependencies in place while the service uses them. Run `pnpm --filter @beddcode/server start uninstall-service` to stop and remove it. `--dry-run` previews either service command without changing the machine.
- `localhost` in a remote host's browser pane means that host. The desktop app forwards the port to this computer through the host's own connection (`/tunnel`, same token and network rules as the app; the host's own port is refused), so a dev server listening only on the host's localhost works, HMR included. A plain browser cannot open ports, so there it swaps in the host's address instead, which needs the dev server to listen beyond localhost (for example `vite --host`).

### Projects, worktrees and git

- Add folders from the sidebar's **Add folder** menu: Browse… opens the system folder picker in the desktop app (an in-app folder browser, backed by `folders.browse`, on remote hosts and in the plain web app), and recent folders are one click away. Nothing is typed. New sessions can run in the folder itself or in a **worktree** (`<repo>/.wt/<branch>`, ignored by git), so several agents can work in parallel on separate branches.
- Start a session with **No project** to ask questions or work without selecting a folder. These sessions appear together under **No project** on their host. Each uses a persistent folder in BeddCode's data directory, so session files and agent resumes survive restarts. Pick a folder in the composer, or use a project's **+**, to start a project session instead.
- The git pane (changes, commits, pull request) reads the selected folder live through your own `git`, including before a conversation starts. Pull requests use your signed-in GitHub CLI (`gh`); BeddCode never stores a token, and pushing or opening a PR only happens when you click the button.

In **Git → Changes**, select files and click **Generate message** to draft a commit summary and description with Claude Code, Codex, or a configured ACP agent on that host. The themed agent picker chooses which account generates the draft. Edit the result, then choose **Commit** or **Commit & push**. Unselected staged files keep their staging state. Commit/push progress and results stay visible across Git tabs and pane switches. If pushing fails after a successful commit, the app keeps the commit, shows Git's error, and offers **Retry push** without making another commit. The commit count refreshes after the operation completes. A branch without an upstream shows **Publish branch**.

The **PR** tab also works with the folder's whole GitHub repo through your own `gh`: list open, mine, review-requested or closed pull requests with checks and review state, open one for its description, checks, conversation and files, then comment, mark ready or draft, close or reopen, and merge after a confirmation. This branch's pull request is pinned; if it has none, the tab offers to create one.

In **Git → PR**, choose a base branch and click **Generate PR draft**. The draft uses committed branch changes, excluding uncommitted files. Review and edit it before clicking **Push & create pull request**. Draft generation also works when GitHub is unavailable; creating the PR requires `gh` authentication. Generation runs separately from the conversation in a temporary folder and supplies the diff as context. Native Claude runs without tools and Codex uses an ephemeral read-only thread. ACP generation advertises no client tools, declines file, terminal and permission requests, and selects a read-only or asking mode when offered. ACP has no universal switch to disable an agent's own tools; reported tool use rejects the draft. The agent must already be signed in and return the requested JSON. Generation closes its process afterward, and closes its provider session when the agent supports that operation.

Git drafts keep the selected model but use lower reasoning settings where supported. Claude draft jobs disable extended thinking; Codex uses an advertised minimal/low effort; ACP agents use a lower reasoning choice when they offer one. Conversation settings are unchanged. Context preparation resolves Git metadata once per batch and reads up to four file diffs concurrently; the stale-change check still runs before returning the draft.

**Folder scripts.** Each added folder can keep up to 20 named commands (install, dev server, tests…). They appear as buttons at the top of the **Terminal** pane; one click runs the command in a new terminal titled with the script's name, in the session's own folder or worktree. **Edit** changes them inline. Scripts marked **On new worktree** run by themselves in the new worktree when a session creates one, for example to install dependencies. They are saved on the host with the folder (`projects.setScripts`).

### Panes

Choose a folder and host in the new-session composer, then open Terminal, Files, or Git from the right rail. These tools work without sending a message or starting an agent. Switching folders switches the tools to that folder; terminals and open files stay associated with their original host and folder. Once a conversation starts, its actual working folder is used, including its worktree if one was created.

- **Terminal:** real shells (PowerShell 7 on Windows, `$SHELL` elsewhere) run on the host in the selected folder and survive closing the app; reconnecting replays their recent output.
- **Files:** a lazily loaded tree with search, a CodeMirror editor (Ctrl+S to save, tabs, unsaved-change and changed-on-disk handling), and a file watcher. Paths can never leave the session folder, also through links.
- **Browser:** a small tabbed browser for previewing dev servers. In the desktop app each tab is a native, sandboxed page (an Electron `WebContentsView` in its own persistent session) laid over the pane: back/forward, find (Ctrl+F), zoom, a console with an error count, screenshots and PDFs, devtools, downloads to your Downloads folder, and prompts in the pane for permissions (camera, location, …) and sign-in. Tabs stay alive while the pane is closed; a tab unused for 20 minutes is unloaded and reloads when shown. A crashed or hung page says so and offers Reload. In a plain browser pages open in a sandboxed iframe (some sites refuse to be embedded).

Each pane can add context to the current composer's next message, including a new-session draft. New-session attachments stay separate by host and selected folder. In **Files**, click the paperclip beside a file, in search results, or above the open editor to attach its saved contents, including images. In **Terminal**, select text and click the paperclip in the header to attach it with its terminal and project or session details. In **Browser**, click the pointer button, then an element to attach its HTML, selector and page details; the desktop app also includes a cropped screenshot. Press Escape or click the pointer button again to cancel. Picking elements in cross-origin previews requires the desktop app.

Attachments appear as removable chips in the composer and stay with their host and session when you switch chats. Files are copied on the host and limited to 20 MB each. Save editor changes before attaching them. Wait for attachments to finish before sending; remove a failed attachment to continue.

### Workspace preferences

The first-launch checklist helps connect a host and add a project folder. **Ctrl+K** (Cmd+K on macOS) searches sessions by title, folder, branch, activity, or anything said in them; a match inside the conversation shows the matching words under the session. Right-click a session (or use the conversation's **…** menu) to **Pin to top**; pinned sessions sit in their own section above the folders on every client of that host. The agent chip below a conversation opens session details, permission choices, repository actions, and local session notes.

Sessions with a default name use the first message as their title. Use the conversation's **… → Rename session** menu to choose a name; it is saved on the host. After a host restart, interrupted turns show **Stopped · ready to continue** and an explanation in the conversation. Send another message to resume. Approval cards show whether a request was allowed, denied, or cancelled, and keep the full command available under **Details**.

**Settings** includes General, Appearance, Notifications, Shortcuts, Agents, Permissions, Tools & MCP, Schedules, Phone alerts, Hosts, Git, Editor, Usage, and About. Set the default host and workspace type, choose comfortable or compact density, reduce motion, or change editor font size, indentation, wrapping, and line numbers. UI preferences and session notes are saved on this client. Unsaved editor text survives navigating between panes and Settings within the app; use Ctrl+S to write it to the host.

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
- **What a turn changed, and undo.** In a git folder the host takes a snapshot before and after each turn (a scratch index and hidden `refs/beddcode/checkpoints/…` refs; your index, branches and stash are untouched). The turn then ends with a **Changed N files** card that counts everything the turn did, commands and generated files included, with a lazily loaded diff per file. **Undo** on the latest turn's card puts those files back as they were before the turn, after a confirmation, and only while the agent is idle and the folder still matches the turn's result. Staged changes and commits are left alone. Snapshots wait at most four seconds and skip very large untracked trees; removing a worktree drops its snapshots.
- **Continue with another agent.** The conversation's **… → Continue with another agent** opens the new-session composer in the same folder with a short summary of the session (what you asked, replies, commands, changed files, plan). Pick Claude, Codex or an ACP agent and send it, edited as you like.
- **Typing before the host is ready.** Pressing Enter while the composer is still connecting, the agent is loading or the folder is being read no longer drops the message: the composer shows "Sends as soon as …" and sends once it can. Escape or **Cancel** stops it.
- **Fork, resume, history.** Fork a session from any finished turn. **Resume an earlier conversation** on the new-session screen lists what an agent keeps on its host, including conversations started in its own CLI, and brings one in as a session. Claude, Codex and ACP agents that list their sessions are supported.
- **Agents managing agents.** The new-session chip **Can start agents** (off by default) gives that session BeddCode's tools over a loopback MCP bridge: `start_session`, `send_message`, `get_status`, `read_transcript`, `wait_for`, `stop`, `list_children`. Works with Claude, Codex and ACP agents, across providers. A child never gets looser permissions than its parent; sessions nest 2 deep, with at most 5 children running and 10 in total. The calls show as cards in the transcript that fold to one line (who was started, its task, live status, the result), a child shows a **Started by** banner with a way back, and the parent shows a bar of its children above the composer. Children appear nested under their parent in the sidebar, and their approvals come to you. A child of a **No project** session stays without a project.
- **Browser use.** The chip **Can use browser** (off by default, desktop app) gives an agent `browser_*` tools (tabs, navigate, snapshot, click, type, scroll, screenshot, console, …) that run in tabs of the agent's own. You can take over, stop it or let it continue from a banner; form sends to non-local hosts and JavaScript ask first, depending on the permission mode.
- **Scheduled prompts.** **Settings → Schedules** (per host): run every N minutes or on a cron expression, either starting a fresh session (agent, model, permissions, folder, optional worktree) or sending a heartbeat to an existing one. Schedules run on the host with every app closed and keep a run history; pause, resume or run one now. A run is skipped while the previous one is going, and missed runs are not backfilled.
- **Phone alerts.** **Settings → Phone alerts** (per host): the host sends a push to paired phones when a turn finishes, an agent needs you, a turn fails or a scheduled run finishes; each phone picks its events, and tapping one opens the session. Push needs a Firebase `google-services.json` and an EAS project (see the Android section); an optional [ntfy](https://ntfy.sh) topic works without either. Desktop and web keep their OS notifications.
- **Tools & MCP.** Settings → Tools & MCP lists, adds and removes MCP servers by running the agent's own CLI (`claude mcp`, `codex mcp`), so its own config files stay the single source.
- **Commands and skills.** Typing `/` in the composer lists the agent's slash commands and skills (Claude's live list, Codex skills, an ACP agent's available commands).
- **ACP extras.** Agents' own settings (model, reasoning effort, modes, commands) appear in the composer, including on the new-session screen: the host starts the agent once to read them (`agents.preview`) and remembers the answer, so custom commands such as `grok agent stdio` get the same picker as any registry agent. Choices made there are applied as the session starts. Pictures go to agents that accept images; start-up has timeouts and failures include the agent's last stderr line.

## Layout

- `apps/server` – headless host daemon (HTTP `/health`, WebSocket `/ws`)
- `apps/desktop` – Electron shell; starts and supervises the local host, so the app does not need a terminal
- `assets/logo` – the logo; `node scripts/make-icons.mjs` renders every icon from it
- `apps/web` – React UI
- `apps/mobile` – Expo (React Native, SDK 58) app for a phone on your tailnet. It pairs with a host (address and six-digit code), lists sessions across hosts, and has the desktop's thread, terminal, files, git and browser panes along the bottom, in the same dark design. It shares the wire protocol, event replica and host catalog with the web app through `packages/client-runtime`. `pnpm --filter @beddcode/mobile start` runs the dev server (Expo Go or a development build; the phone needs Tailscale). The terminal page is generated from xterm.js: run `pnpm --filter @beddcode/mobile build:terminal` after changing `scripts/terminal-page.html` or the xterm version. Attaching context works from the Files pane (lines of a file), the Terminal pane (selected text), the Browser pane (a tapped element, sent with a comment) and the composer's + menu (photos).
- `packages/contracts` – wire and event schemas
- `packages/shared` – logging and async helpers
- `packages/provider-core` – provider adapter interface
- `packages/provider-claude`, `provider-codex` – native adapters; `provider-acp` – generic ACP client (registry agents and local commands)
- `packages/client-runtime` – host connection runtime
- `packaging/winget` – the winget manifests and how to submit them
- `docs` – the plan ([PLAN.md](docs/PLAN.md)), design screenshots, and product proposals in `docs/prd` (agent orchestration "Flows" and computer use; neither is built yet)

## License

[MIT](LICENSE)
