# BeddCode — Implementation Plan (Plan B)

Decisions locked in:

- **Providers:** native Claude adapter (Claude Agent SDK) + native Codex adapter (`codex app-server`) + generic ACP adapter for everything else (Gemini CLI, OpenCode, custom ACP commands, registry agents).
- **Permissions:** no permission system of our own. We relay each agent's own approval requests to the UI and map the composer's mode picker to the CLI's native modes. Modes a CLI doesn't have are not offered.
- **Platforms:** Windows + Linux (no macOS).
- **Hosts:** local ("This PC") and remote, all inside one Tailscale tailnet. No SSH anywhere.
- **Stack:** Electron + React + TypeScript, pnpm monorepo, Node server.
- **Reuse:** t3code / synara / paseo are reference only. Nothing is copied.

## 1. Architecture

```
Electron app (renderer: React)           Remote machine (Linux/Windows)
  └─ client-runtime ── WebSocket ───┐      └─ beddcode-server (headless)
Electron main                       │            ├─ provider adapters
  └─ spawns local beddcode-server ──┤            ├─ sessions / event store (SQLite)
                                    └─ tailnet ──┴─ git, terminals, files
```

- **One server binary** (`apps/server`) is both the local host (spawned by Electron) and the remote host (run headless as a service on any tailnet machine). The UI only ever talks to a server over WebSocket, so local and remote are the same code path.
- A **host** owns: provider CLIs and their credentials, project folders, worktrees, terminals, files, and durable state. A session belongs to exactly one host.
- **Provider adapters** convert each CLI's native protocol into one internal event stream: `message.delta`, `tool.started/updated/completed`, `diff`, `plan`, `approval.requested`, `question.requested`, `turn.completed`, `usage`, `error`. The UI and store know nothing about the provider.
- **Event log first:** every event is appended to SQLite before it is sent to clients. Reconnects resume from a sequence number. Sidebar state, transcripts and "needs you" badges are projections of the log.

### Packages

| Package                    | Role                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/contracts`       | Zod/TS schemas for the wire protocol and internal events. No runtime logic.                       |
| `packages/provider-core`   | `ProviderAdapter` interface, capability flags, event normalizer helpers.                          |
| `packages/provider-claude` | Claude Agent SDK adapter.                                                                         |
| `packages/provider-codex`  | `codex app-server` JSON-RPC adapter.                                                              |
| `packages/provider-acp`    | Generic ACP client adapter (spawn command, stdio JSON-RPC, fs/terminal client methods).           |
| `packages/client-runtime`  | Connection manager, reconnect, host catalog, event replica for the UI.                            |
| `packages/shared`          | Process spawning (Windows `.cmd` shims, teardown), path helpers, logging.                         |
| `apps/server`              | Daemon: WS API, sessions, event store, git/worktrees, terminals, files, tailnet binding, pairing. |
| `apps/web`                 | React UI (your ui-docs designs).                                                                  |
| `apps/desktop`             | Electron shell, spawns local server, browser pane, native menus, updater.                         |

### Engineering decisions

- **Tooling:** pnpm workspaces + Turborepo, Node (LTS) for the server and Electron main. TypeScript strict, one shared `tsconfig.base.json`.
- **Server style:** plain TypeScript + Zod. Small services as classes/factory functions with explicit dependencies, cancellation via `AbortSignal`, streams via async iterators. No Effect-TS: it is the most flexible to hire for and debug, and nothing here needs its machinery.
- **Wire protocol:** one WebSocket per host connection carrying (a) typed request/response RPC, (b) a sequenced event subscription backed by the event log, (c) binary frames for terminal data. Schemas live in `contracts`.
- **UI state:** TanStack Router for routing, Zustand stores fed by the event replica in `client-runtime`. Server-derived data is never duplicated into ad-hoc component state.
- **Persistence:** SQLite via Node's built-in `node:sqlite` (no native module to rebuild for Electron), append-only events plus projection tables; migrations are an ordered list applied through `user_version`. Revisit `better-sqlite3` only if `node:sqlite` proves too limited.

### Project structure

```
BeddCode/
├─ apps/
│  ├─ server/                 headless daemon (local + remote host)
│  │  └─ src/
│  │     ├─ main.ts           CLI entry: serve, install-service, pair
│  │     ├─ transport/        WS server, RPC router, auth + pairing, tailnet binding
│  │     ├─ sessions/         session lifecycle, turn queue, adapter registry
│  │     ├─ store/            SQLite, event log, projections, migrations/
│  │     ├─ workspace/        projects, git, worktrees, PR (gh)
│  │     ├─ terminals/        node-pty manager
│  │     ├─ files/            fs access, watcher
│  │     └─ agents/           detection, versions, sign-in status
│  ├─ web/                    React UI
│  │  └─ src/
│  │     ├─ routes/           TanStack Router (thread, settings/*, onboarding/*)
│  │     ├─ features/         sidebar, thread, composer, git, terminal, files, browser
│  │     ├─ stores/           Zustand
│  │     └─ ui/               design-system components + tokens from ui-docs
│  └─ desktop/                Electron
│     └─ src/                 main, preload, local-server supervisor, browser pane, updater
├─ packages/
│  ├─ contracts/              wire + event schemas (Zod), capability flags
│  ├─ shared/                 process spawn/kill, paths, logging, small utils
│  ├─ provider-core/          ProviderAdapter interface, event normalizer helpers, test kit
│  ├─ provider-claude/        Claude Agent SDK adapter
│  ├─ provider-codex/         codex app-server adapter
│  ├─ provider-acp/           generic ACP adapter + registry catalog
│  └─ client-runtime/         connection manager, host catalog, reconnect, event replica
├─ docs/                      PLAN.md, architecture notes, ui-docs link
├─ ui-docs/                   existing design screenshots
├─ scripts/                   dev runner, release, fixture recorders
├─ package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json
```

Dependency rules (enforced with lint): `contracts` depends on nothing; `provider-*` depend only on `contracts`, `shared`, `provider-core`; `apps/server` depends on providers; `apps/web` and `apps/desktop` depend on `client-runtime` + `contracts` and never import server code.

## 2. Provider adapters

### Capability flags

Each adapter declares what it really supports: resume, fork, steering mid-turn, plan mode, image input, native permission modes (list), model list, effort levels, usage reporting. The UI reads flags, never the provider name.

### Claude (Agent SDK)

- Run the user's installed Claude Code login/config. Support `CLAUDE_CONFIG_DIR` per instance for multiple accounts.
- Permission modes map 1:1 to SDK modes: default → "Ask before edits", acceptEdits → "Auto-accept edits", plan → "Plan mode", bypassPermissions → "Full access".
- Approvals via the SDK's permission callback → `approval.requested`; the UI answer is returned unchanged. "Always for this session" uses the SDK's own permission update, not our own rule store.
- Session resume from Claude's own transcript store.

### Codex (`codex app-server`)

- Spawn `codex app-server` (stdio JSONL JSON-RPC). Thread/turn/item model; `turn/start`, `turn/interrupt`, `turn/steer`.
- Server-initiated `requestApproval` requests → `approval.requested`; reply with the decision the user picked.
- Map approval policy / sandbox mode to the composer picker using Codex's own values.

### ACP (generic)

- Spawn command, `initialize` (advertise `fs` + `terminal` client capabilities), `session/new`, `session/prompt`, handle `session/update` notifications.
- Client methods we must implement: `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*` (backed by our node-pty terminals).
- Agent registry catalog for "Add agent", plus "Local ACP command" (executable + args + env). Gemini CLI and OpenCode arrive here.
- Permission modes come from the agent's ACP session modes; show what it reports.
- First spike: confirm the registry list and pin protocol version negotiation (v1 and the newer preview).

### Shared concerns

- Agent detection ("Agents found on this PC"): resolve executables, run `--version`, check sign-in without starting sessions that launch MCP servers/hooks.
- Sign-in: for v1, link to the CLI's own login (run it in an in-app terminal on the host).

## 3. Remote hosts over Tailscale

- Server binds to the tailnet interface (100.x address) or `0.0.0.0` with a tailnet-only guard; refuse non-tailnet peers by default. Discovery: `tailscale status --json` on the client lists reachable peers running BeddCode (probe the port), so "Add host" can be a picker with MagicDNS names instead of typing URLs.
- **Auth is minimal, not a permission system:** first connection uses the 6-digit pairing code shown by the server (matches your onboarding screens), exchanged for a long-lived bearer token stored per client. Tailnet membership is the network boundary; the token is the identity.
- Optional later: Tailscale Serve for HTTPS/MagicDNS certs.
- Host identity is a stable ID independent of address, so a changed IP doesn't create a duplicate host.
- Remote service install: `beddcode-server install-service` (systemd on Linux, scheduled task / NSSM-style service on Windows).
- Clients save an ordered list of routes per host (tailnet name, tailnet IP) and fall back automatically.

## 4. Workspace features

- **Projects/sessions:** a project is a folder on a host; sessions group under it in the sidebar with status (running / needs you / done / failed), diff stats, branch and agent.
- **Worktrees:** `git worktree add` from the chosen base; session starts in the worktree after it is ready (show "Preparing worktree").
- **Git pane:** status/changes, per-file diffs, commits, PR creation via `gh`; clean-state empty views.
- **Terminal pane:** node-pty (ConPTY on Windows) + xterm.js, server-side, streamed with coalescing/backpressure.
- **Files pane:** tree + editor (Monaco or CodeMirror; decide in a short spike), file watcher with debounce.
- **Browser pane:** Electron `WebContentsView`; for a remote host, the page to preview is reached through the tailnet.
- **Attachments, issue-link prompts, notifications** (desktop toast on "needs you").

## 5. Phased roadmap

| Phase | Deliverable                                                                     | Done when                                                           |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0     | Monorepo, lint/typecheck/test, contracts skeleton, design tokens from ui-docs   | `pnpm test` green; empty Electron window shows the layout shell     |
| 1     | Server + event store + WS API + client-runtime; one fake adapter                | UI renders a scripted fake session; reconnect resumes by sequence   |
| 2     | Claude adapter                                                                  | Real Claude turn streams, edits show as diffs, approval round-trips |
| 3     | Codex adapter                                                                   | Same scenarios pass on Codex                                        |
| 4     | ACP adapter                                                                     | Gemini CLI (and one more) work; custom ACP command dialog           |
| 5     | Thread UI polish: composer pickers, mode picker, edited-files card, attachments | Matches ui-docs 01 and 04                                           |
| 6     | Projects, worktrees, git pane, PR flow                                          | Parallel sessions in separate worktrees                             |
| 7     | Terminal, files, browser panes                                                  | Matches ui-docs 02 and 03                                           |
| 8     | Remote hosts over tailnet, pairing, headless server install on Linux            | Two machines, one session each, visible in one sidebar              |
| 9     | Onboarding wizard + Settings pages                                              | Matches ui-docs 05 and 06                                           |
| 10    | Packaging: Windows installer, Linux AppImage/deb, auto-update                   | Clean-machine install works on both                                 |

Milestone 1 (usable alpha) = phases 0–5 on the local host.

Current follow-up work:

- Phase 8 has local two-host integration coverage, pairing/revocation, replay, and route fallback. A test across two physical tailnet machines and Linux service installation remain.
- Phase 9 now has the first-launch checklist, Settings navigation, General/Appearance/Shortcuts/Permissions/Hosts/Git/Editor pages, agent detection/refresh, ACP registry/custom-agent management, and per-host defaults for new sessions. The workspace, panes, and Settings follow the Brilliant design. The full remote-host onboarding wizard, notifications, Tools & MCP, and usage reporting remain.
- Before phase 10, connect Electron to a supervised local daemon so opening the app does not depend on a development terminal. Then build and test installers on clean Windows and Linux machines.

## 6. Cross-cutting rules

- **Replay-fixture tests:** record real provider transcripts, replay through the adapter + store, assert projections. Needed for each adapter.
- **Windows process handling** lives in one helper (`shared`): resolve `.cmd/.exe`, quote args, kill process trees. Never kill by name pattern.
- **Performance:** coalesce assistant text deltas (~25 ms), cap live-stream budgets, avoid sending full transcripts on every update.
- **Untrusted content:** repo files, agent output and logs are data; they never authorize actions.

## 7. Risks and open items

- Claude Agent SDK surface and ACP/Codex protocol versions change quickly; pin versions and keep adapters thin.
- ACP adapter packages for Claude/Codex are not used here (native adapters instead), but registry agents vary in quality; capability flags must stay honest.
- Tailscale-only auth means anyone on the tailnet can reach the port until paired; confirm that is acceptable or add Tailscale ACL guidance.
- Embedded browser pane for remote hosts needs a design decision (proxy vs. direct tailnet URL).
- Licenses: reference repos only; do not copy code.
