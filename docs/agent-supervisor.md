# Agent supervisor: agents that survive a host restart

Status: implemented for the Claude Code CLI backend, opt-in. Enable it with
`BEDDCODE_AGENT_SUPERVISOR=1` or `"agentSupervisor": true` in `config.json`. Everything else is
unchanged, and with it off nothing here runs.

## Problem

Agent CLIs are children of the host (`apps/server`). When the host restarts (dev reload, upgrade,
crash) their stdio pipes close, the agents die, and `recovery.ts` can only _resume the conversation
in a new process_ and re-send the last prompt. Work in flight (a long tool call, a half-written
answer) is lost. The supervisor keeps the process itself alive.

## Which providers can be reattached

What matters is whether a _new_ host can talk to the _same_ process, so it comes down to the wire
protocol, not to the supervisor.

| Provider                       | Transport                                                 | Reattach                                                                                        | Notes                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude CLI (`provider-claude`) | stream-json over stdio, driven by the Agent SDK           | **Yes** (prototyped)                                                                            | The SDK has a `spawnClaudeCodeProcess` hook, so the supervisor's pipe stands in for the child. The protocol is line-oriented JSON with one stateful part (see "Reattach protocol").                                                   |
| Codex (`provider-codex`)       | JSON-RPC (app-server) over stdio                          | Feasible, medium                                                                                | JSON-RPC has `initialize` and request ids held by the _host_ side; reattach needs the same init-replay trick plus replay of unanswered server requests (approvals). Thread state is on the server, so `thread/resume` semantics help. |
| ACP (`provider-acp`)           | JSON-RPC (ACP) over stdio                                 | Feasible, medium                                                                                | Same shape as Codex; `session/load` capability is optional per agent, so unknown agents need a per-agent allow-list.                                                                                                                  |
| Grok, OpenCode                 | JSON-RPC / ACP-like over stdio, or HTTP server (OpenCode) | OpenCode: easy (it is already a server, the host only needs to remember its port); Grok: as ACP | OpenCode's server mode makes the supervisor optional: persist port and password, reconnect.                                                                                                                                           |
| Pi (`provider-pi`)             | RPC over stdio                                            | Feasible, medium                                                                                | Same pattern.                                                                                                                                                                                                                         |

Order of value/effort: Claude (done), Codex, ACP family, OpenCode (no supervisor needed).

## Who owns the pipes

A single detached `daemon.mjs` per data folder (`<home>/supervisor`) spawns the agent with
`stdio: pipe` and keeps all three pipes. The host never holds the agent's pipes in this mode, only a
socket to the daemon, so closing the host closes nothing the agent depends on.

- stdout is appended to a log file (`logs/<id>.out`) and also streamed to the attached host. While no
  host is attached the agent keeps running and its output keeps landing in the log, so nothing is
  lost and the agent never blocks on a full pipe.
- stderr is drained and streamed (the host keeps a tail to explain exits).
- stdin is written only by the currently attached host.
- The daemon is **not** a tracked child of the host (`trackChild`), so neither the host's exit
  handlers (`killAllChildren`) nor `reapOrphans` touch it or its agents.

Safety valves, because a daemon holding agents is a leak risk: agents with no host for
`BEDDCODE_SUPERVISOR_GRACE_MS` (default 15 min) are ended; the daemon exits after
`BEDDCODE_SUPERVISOR_IDLE_MS` (default 60 s) with nothing to hold.

## Wire protocol (daemon <-> host)

Newline-delimited JSON over a local socket: a named pipe on Windows
(`\\.\pipe\beddcode-sup-<hash of dir>`), `supervisor.sock` in the folder elsewhere. The first frame
must be `hello` with the token from `supervisor.json` (written `0600`; this is what keeps other local
users out of the pipe).

Host to daemon: `hello`, `list`, `spawn {id,command,args,cwd,env,meta}`, `attach {id}`,
`in {data}`, `ack {off}`, `meta {meta}`, `close-stdin`, `kill`, `release`.
Daemon to host: `hello`, `agents`, `spawned`, `attached {pid,alive,meta}`, `out {off,data}`,
`err {data}`, `exit {code,signal}`, `detached`, `error`.

One connection serves one agent; attaching a second connection replaces the first (`detached`).
Spawning an id that already exists ends the stale agent first (one agent per session).

## Reattach protocol

1. **Planned restart.** `SessionManager.close()` calls `session.detach()` instead of `close()`: the
   session lets go of the socket (nothing more is written to the agent, the SDK's own stdin-EOF and
   kill become no-ops) and only then closes the SDK query. The agent keeps running. The existing
   `host.updating` marker is still written, so `recovery.ts` is the fallback described below.
2. **Boot.** `resumeAfterRestart` marks the session for reattach; `adapter.startSession` asks the
   daemon to `attach {id}`. If an agent is alive, the new `ClaudeSession` gets a process object
   backed by the socket and starts a _new_ SDK query on it, with no prompt queued.
3. **Replay.** The daemon sends (a) any request the agent made that nobody answered (permission
   prompts, `control_request`s tracked by `request_id`, dropped once a `control_response` or
   `control_cancel_request` is seen), then (b) the log from the last _acknowledged_ offset, then
   `exit` if it ended meanwhile. The host acknowledges after each whole line it has handed to the
   SDK, so a restart replays only what the old host never took in (at-least-once, line aligned).
4. **Handshake.** The new SDK query sends `initialize` again, which the live agent already answered.
   The daemon answers from the cached first response (rewriting `request_id`) and does not forward it.
5. **State outside the protocol.** `ClaudeSession` stores `{turnCount, turnActive}` with the agent
   (`meta`), so the new session resumes numbering turns and knows a turn is running.
6. **Skip the re-prompt.** `session.reattached === true` makes `resumeAfterRestart` skip re-sending
   the last prompt; the turn finishes from the replayed stream.

### Host crash or hard kill (no marker)

The desktop app stops the host with `taskkill /T /F` on Windows, which runs no shutdown code, so
"planned restart" cannot be relied on. At boot, `runServer` asks the daemon which agents it holds
(`SupervisorClient.list()`) and passes them to `recoverInterruptedTurns(store, held)`. A session with
an open turn whose agent is still alive is queued for `resumeAfterRestart` with no prompt instead of
being marked cancelled; reattaching replays everything the old host missed. If the agent turns out
to be gone by then, the turn is cancelled with a message (there is no prompt to resend).

The daemon is started through a short-lived launcher so it has no live parent: `taskkill /T` and
process-group kills aimed at the host's tree do not reach it. On POSIX it is also `setsid`-detached.

### Fallback (unchanged path)

If there is no daemon, the agent died, or attach fails, `startSession` returns an ordinary session
and `resumeAfterRestart` runs exactly the old path: resume the conversation from the agent's own
history and re-send the last prompt. A host that crashes with no marker still goes through
`recoverInterruptedTurns` (turn marked cancelled); a stale agent is replaced at the next `spawn`.

## Windows constraints

- Named pipes instead of unix sockets (no path length limit to worry about; the name is a hash of
  the data folder). Access control is the token, not the pipe ACL.
- The daemon is started `detached` + `windowsHide`. A host launched inside a Job Object with
  kill-on-close (some service managers, CI, some launchers) kills detached children anyway; Node
  requests breakaway but the job may forbid it. Run the host so that it is allowed to break away, or
  the daemon dies with it and the feature degrades to the fallback.
- No signals: ending an agent is stdin EOF, then `taskkill /T /F` on the tree (npm shims are
  `cmd.exe` wrappers, so the tree matters).
- `reapOrphans` and `taskkill /T` from the host must never be pointed at the daemon: it is outside
  the host's ledger on purpose.
- Pid reuse: the daemon refers to agents by id and its own `ChildProcess`, never by pid alone.

## Operational notes

- The log is bounded: once the host has taken in 4 MB, the front of the file is cut away; offsets
  stay absolute. Replay streams in 256 KB slices cut at newlines.
- `daemon.log` in the supervisor folder holds the daemon's own stderr.
- A daemon with another `PROTOCOL_VERSION` is refused and the host falls back to starting agents
  itself. After an upgrade the old daemon exits when its agents are gone or past the grace period.
- Installed hosts ship `server/daemon.mjs` beside `main.mjs` (`apps/desktop/scripts/build-host.mjs`).
- Closing a session from the UI (stop, delete) still ends its agent; only a host shutdown detaches.

## Known limits

- Output between the last acknowledgement and a host crash can be replayed (line-granular,
  at-least-once). Assistant `message.delta`s of a partial streamed message could repeat; ids on
  messages would allow de-duplication in the mapper.
- Replay hands the new SDK a stream that starts mid-turn; the mapper tolerates this for
  `assistant`/`user`/`result` messages, mid-stream `stream_event` partials are best effort.
- Output the host never takes in (a host that stays away for the whole grace period) is kept in the
  log without a size cap until the agent is ended.
- One daemon per data folder.
- Only the Claude CLI backend is wired; see the table for the others.
- The dev reloader can stop waiting for running turns once this is on by default; it is unchanged.

## Test

`packages/provider-claude/src/supervisor/supervisor.test.ts` drives the real Agent SDK against a
fake stream-json CLI (`fakeClaude.mjs`): host 1 starts a turn and detaches mid-turn, host 2 (new
client and adapter) reattaches. It asserts the agent was started once, kept the same pid, and that
every part of its output arrived exactly once across both hosts.
