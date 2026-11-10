# Ideas from the reference projects

## Paradev source review (2026-11-09)

Reviewed [Paradev](https://github.com/paradevai/paradev) at commit `a865880dad4265cbcc188753506ab0abdbce701e`. Its [port scanner](https://github.com/paradevai/paradev/blob/a865880dad4265cbcc188753506ab0abdbce701e/packages/port-scanner/src/scanner.ts) associates listening sockets with terminal process trees, and its [port manager](https://github.com/paradevai/paradev/blob/a865880dad4265cbcc188753506ab0abdbce701e/packages/port-scanner/src/port-manager.ts) removes stale ports, scans idle terminals less often, and validates ownership before stopping a process. This is a useful next step for previews: BeddCode currently only remembers URLs printed to terminal output, so silent servers are missed and stopped servers may remain listed. Process attribution and platform-specific scanning need their own tests before exposing a stop action.

Paradev's [terminal attach diagnosis tests](https://github.com/paradevai/paradev/blob/a865880dad4265cbcc188753506ab0abdbce701e/apps/desktop/src/renderer/lib/terminal/attach-retry-diagnosis.test.ts) also cover repeated connections that open but never attach, silent closes, and clearing stale error messages after the failure mode changes. These cases are worth checking against BeddCode's terminal reconnect path. No Paradev code was copied.

## Ecosystem scan: agentic dev environments and control planes (2026-11-09)

A web pass over what ships today, beyond the local checkouts above. The useful split: **agentic dev
environments** (a host that runs agents on your machines), **cloud sandboxes** (Daytona, E2B, Modal,
Runloop, Coder, DevPod — fast create/resume, snapshots, port forwarding, secrets), **multi-agent
orchestrators** (Vibe Kanban, Conductor, Gastown/Beads, agent-swarm, Claude Squad — worktree
isolation, kanban stages, leader→worker delegation, dependency-aware task graphs, merge queues),
**observability control planes** (Langfuse MIT, AgentOps MIT, Phoenix, Braintrust — traces, session
replay, cost), and **MCP control planes** (ToolHive containers+policy, vMCP aggregation, registry
governance). Local dev control planes (Tilt, Garden, Skaffold) contribute the file-watch → rebuild
loop; GitButler the parallel-branch UI.

Implemented in BeddCode from this scan:

- **Host self-monitoring like any other service:** `GET /metrics` (Prometheus text; loopback free,
  other peers need a paired token) and the `host.stats` RPC, counted by
  `apps/server/src/telemetry/hostMetrics.ts` — sessions by status, active turns/tools, open
  approvals, queued prompts, ws clients, db/attachment bytes, stale worktrees, uptime, and counters
  since start. CLI: `beddcode stats [--json]`. `/health` now carries a housekeeping hint for
  `beddcode doctor`.
- **Housekeeping:** `host.gc` RPC + `beddcode gc [--days N] [--dry-run] [--worktrees] [--yes]`
  (`apps/server/src/housekeeping.ts`): deletes sessions quiet for N days (never running, waiting,
  or pinned), optionally removes their worktrees and stale `.wt` folders, sweeps attachments no
  event references anymore, and vacuums the log (T3 Code's "reclaim database space", Vibe Kanban's
  worktree auto-cleanup). `retention-days` config sweeps daily on a timer. `beddcode doctor` warns
  on a heavy log or stale worktrees.
- **Watch triggers:** `beddcode schedule add --watch "src/**/*.ts" "run the tests"` — schedules can
  now fire on file changes (Tilt/Skaffold-style), with a debounce, a persisted baseline so a host
  restart does not fire everything, and the changed files named in the prompt. Web settings form
  has an "On file change" repeat.
- **CLI QoL:** `beddcode rename`, `beddcode notes`, `beddcode rm` over the existing RPCs.

Also shipped from that list (2026-11-09):

- **`run_subagent` agent tool:** start a child on any provider and wait for its answer in one call
  (`start_session` + `wait_for`), same permission cap and nesting limits, idempotent by `request_id`.
- **Preview URL detection:** `localhost:PORT` URLs printed in terminal output are collected per
  terminal (`TerminalInfo.previews`), listed by `previews.list` / `beddcode previews`, and offered
  as an "Open preview" button in the terminal tab.
- **MCP policy records per server and project:** `mcp.policy.list/set`, stored in the ProjectStore;
  an off switch and allow/deny tool lists, annotated on `mcp.list` / `mcp.overview` and editable
  under Settings → Tools & MCP. `mcp.test` refuses disabled servers and reports `blockedTools`.
  These records do not enforce policy on agent-owned MCP connections.
- **Diff paging:** `git.diff` takes `offset`/`maxLines` and returns `totalLines`/`nextOffset`; the
  Changes tab has "Load more" for cut-off diffs.
- **Provider replay in CI:** `pnpm test:replay` and the `Provider replay` workflow, which runs on
  provider package, fixture or lockfile changes.

- **acpx (openclaw/acpx, MIT):** its agent launch table became `packages/provider-acp/src/known.ts` (installed-agent detection, `agents.known` RPC, "Found on this machine" in Add agent), and its per-agent launch fixes became `launch.ts` (Gemini flag by version, startup-failure hints). Not taken: its session queue/flows runtime, which duplicates BeddCode's host.

Suggested next (items 2, 3, 4, 5 and 6 below are done, see above), in rough order of value:

1. **Task graph / dependencies for orchestration** (Beads-style): let a template task say
   "after task A", so a pipeline of agents runs in order; the board stage UI already exists.
2. **Sub-agent tool for agents** (T3 Code's MCP sub-agents): let a session spawn a bounded child
   agent on any provider and wait for its result — peer messaging exists, this packages it as a tool.
3. **Preview URL detection:** parse `localhost:PORT` from terminal output of project scripts and
   surface "Open preview" per session/worktree (Paseo preview URLs; Daytona port forwarding).
4. **Provider fixture replay at scale:** replay the recorded transcripts through adapters in CI on
   every provider bump (T3's replay tooling) — already an open PLAN.md item.
5. **Diff paging / bounded transcript loads** for very long sessions (T3's live-stream budgets) so
   a remote reconnect stays cheap.
6. **MCP gateway policies per server** (ToolHive): allow/deny tool lists and per-server secrets in
   the gateway config, not just a global switch.
7. **Session export/import archive** (0XB-45's resumable archive): the Markdown export exists;
   package it with metadata so another host can resume it.
8. **Cloud sandbox bridge:** an optional adapter that runs a session in Daytona/E2B instead of
   locally, keeping the same UI (the ADE comparison shows resume-from-snapshot is the winning
   primitive).

## Workspace quality of life (2026-11-01)

Branch: `codex/workspace-quality-of-life`.

- Attachment uploads now have a three-job limit per host, a visible waiting state, and in-place retry after a failure. Removing a waiting attachment prevents its upload from starting; removing an active one prevents its late result from restoring the chip. Active RPC uploads cannot currently be aborted. Inspired by T3 Code's `apps/web/src/lib/attachmentUploadQueue.ts`; implemented with BeddCode's existing upload RPC.
- Closing a live terminal asks for confirmation. Failed close requests keep the tab visible and report the error, allowing another attempt.
- Selected agent reply text can be quoted into the current draft without replacing its contents. Inspired by MonoCode's transcript selection actions.
- Transcript reading position anchors to message identity when earlier history is shown or content above the reader changes size. Inspired by PandaCode's transcript anchoring; BeddCode keeps its existing React rendering and follow-end behavior.
- Session menus can export the loaded transcript as Markdown with a coverage manifest. Secret question answers are omitted; attachment bytes and snapshot file contents are explicitly excluded. This is the first slice of 0XB-45, not a resumable archive or an attachment bundle.
- Multi-question cards show answer progress and can focus the next unanswered question.
- Truncated Git diffs explicitly report incomplete review and offer to open the current file. Turn-change cards explain snapshot attribution and incomplete file lists. These address portions of 0XB-53 and 0XB-47; diff paging, submodule handling and exact change attribution remain separate work.
- Confirmations opened from a native modal stay inside that modal, fixing device revocation from the Hosts dialog.

The changes use the local reference projects for behavior and retain BeddCode's existing architecture. No reference implementation was copied. Desktop fixture checks exercise quoting and export, failed terminal close and retry, reading-position preservation, and device revocation in the native Hosts modal. Web tests exercise upload host isolation, concurrency, removed waiting jobs, retries and export redaction.

## Pi and OpenCode adapters (2026-10-31)

Reviewed [Paseo's provider guide](https://github.com/getpaseo/paseo/blob/main/docs/providers.md) and
OpenCode's [ACP documentation](https://opencode.ai/v2/docs/cli/acp/). Paseo's Pi notes surfaced two
compatibility cases now handled in BeddCode: send image blocks only when the active Pi model reports
image input, and keep the model/thinking setting in sync when Pi changes either during a session.
OpenCode's version-aware native server adapter is designed for Paseo's broader bridge and server
management; BeddCode keeps to OpenCode's supported ACP entry point, which already provides model,
variant/effort, mode, permission, command, and session configuration through the protocol.

These are behavior-level references. No Paseo adapter code was copied; see
`THIRD_PARTY_NOTICES.md` for the acknowledgement.

Reviewed the local `paseo`, `synara`, and `t3code` checkouts on 2026-10-23. This is a source and test review, not a runtime reliability comparison. The recommendations below fit BeddCode's native provider adapters, Node/SQLite host, React/Zustand client, and Tailscale connections. Reference implementations were examples in that first pass; later code adapted from permissive projects is listed in `THIRD_PARTY_NOTICES.md`.

## Git workflow implemented

The Git pane now generates an editable commit message from selected changes, or a PR title and description from commits and the diff against an explicit base branch. It uses Claude Code, Codex, or a configured ACP agent on the owning host. Generation runs separately from the conversation, with bounded context and a check that the context did not change while generating.

This follows the useful product pattern in [Paseo's metadata generator](C:/Users/basin/inspo/paseo/packages/server/src/server/session/checkout/git-metadata-generator.ts): use the agent the user already has, then present the draft for editing. BeddCode reports generation failures instead of silently substituting a generic message.

[Synara's ACP text generator](C:/Users/basin/inspo/synara/apps/server/src/git/Layers/AcpTextGeneration.ts) confirms the ACP approach: create a separate runtime, collect text chunks, bound output, validate the structured result, and close the runtime. BeddCode uses its existing ACP adapter for this flow, with no advertised client tools, automatic denial of client tool requests, and a temporary working folder. ACP does not standardize disabling agent-owned tools, so reported tool use fails generation. Compatibility depends on the configured agent accepting a standalone prompt and returning JSON. Its own storage may retain the short-lived session if it lacks a close operation.

The workflow also preserves unrelated staged files, commits both sides of a selected rename, serializes commit/push operations for a checkout, and distinguishes a saved commit from a failed push. The Commits tab can publish a branch or retry the push. PR drafts remain available when GitHub is unavailable; creating the PR still requires working `gh` authentication.

Verified with the full test suite, build, typecheck, lint, Electron interactions against temporary repositories and a local bare remote, live generation through both native providers, and live ACP generation through Grok. The themed picker and ACP commit/PR flow also have Electron fixture coverage. No real GitHub PR was created during verification.

## ADE features adapted (2026-10-29)

A second pass over T3 Code, Paseo, Synara, MonoCode, opencode and Crystal, this time copying code where the license allows (see `THIRD_PARTY_NOTICES.md`):

- **`.worktreeinclude`** (from Paseo's worktree-include plugin, MIT): a new worktree gets the ignored local files its repository lists in `.worktreeinclude` (gitignore syntax), such as `.env`. Only files git ignores are copied, existing files are kept, symlinks are skipped, and an oversized match (over 1000 files) copies nothing. The session header says how many files came along.
- **Open in editor** (from T3 Code, MIT): `editors.list` and `editors.open` find Cursor, VS Code (+ Insiders), VSCodium, Windsurf, Trae, Kiro, Zed, JetBrains IDEs and the file manager on PATH or in their usual install folders, and open a folder, or a file at a line. Only the host machine itself may open one (loopback connections), since the editor appears on its screen. The thread header gets an "Open in" menu, and the Files pane opens the current file at the cursor.
- **Command palette** (interaction from T3 Code, ranking adapted from its search ranking, MIT): Ctrl/Cmd+Shift+P over actions, panes, the current session (open in editor, copy path, pin, stop), projects and every session on every host, with accent-insensitive matching (Greek included).
- **Diff review comments** (from Paseo, Apache-2.0): comment on lines in the Git pane's diffs, then send them all to the session's agent, or attach them to the message being written. The message gives each comment's file, line and the three lines around it; only the comments that went out are cleared.

Item 2 of the table below (diff comments) is now done; items 1 and 4 were done earlier.

Left for later: Synara's numbered browser annotations, T3's background PR status sync, MonoCode's session notes, and clickable `path:line` links in the transcript (the editor RPC is ready for it).

## Best next additions

| Order | Feature                                   | Reference                                                                                                                                                                                                             | How it would work in BeddCode                                                                                                                                                                                                                                                                                         |
| ----- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Drafts that survive restart               | [Synara's draft persistence](C:/Users/basin/inspo/synara/apps/web/src/composerDraftStore.ts) and [persistence tests](C:/Users/basin/inspo/synara/apps/web/src/composerDraftStore.persistence.test.ts)                 | Save composer text, selected agent/model, Git drafts, and attachment references by host and session. Store attachment bytes separately with expiry and cleanup. Current pane attachments survive navigation, but remain in memory.                                                                                    |
| 2     | Diff comments sent to the agent           | [Paseo's review feedback](C:/Users/basin/inspo/paseo/packages/app/src/review/feedback/index.ts)                                                                                                                       | Select diff lines, write several comments, then send them as one attachment to the current agent. Keep comments if sending fails; clear only comments successfully sent. Reuse the attachment composer added for the three pane features.                                                                             |
| 3     | Project commands and preview launch       | [Paseo's worktree bootstrap](C:/Users/basin/inspo/paseo/packages/server/src/server/worktree-bootstrap.ts) and [tests](C:/Users/basin/inspo/paseo/packages/server/src/server/worktree-bootstrap.test.ts)               | Save Dev, Test, and Build commands per project. Start them on the owning host, prevent duplicate launches, track readiness, allocate a port per worktree, and open the correct local or tailnet URL in the browser pane.                                                                                              |
| 4     | Open a PR into a new worktree             | [Paseo's change-request checkout](C:/Users/basin/inspo/paseo/packages/server/src/utils/change-request-checkout.ts) and [tests](C:/Users/basin/inspo/paseo/packages/server/src/utils/change-request-checkout.test.ts)  | Paste a GitHub PR URL, fetch and validate its branch, create an isolated worktree, then start a review session. Reuse `gh`, existing host credentials, and BeddCode's worktree creation. Handle fork remotes and cleanup after failed checkout explicitly.                                                            |
| 5     | Persistent PR status and agent feedback   | [T3's PR synchronization](C:/Users/basin/inspo/t3code/apps/server/src/orchestration-v2/PullRequestSyncReactor.ts)                                                                                                     | Keep a PR linked to its session and refresh checks, review state, and mergeability with a restrained background cadence. Offer “Attach failing check to agent”; notify on meaningful changes. BeddCode already displays checks in the PR tab, so the addition is persistence, background updates, and useful actions. |
| 6     | Several browser annotations in one prompt | [Synara's annotation contract](C:/Users/basin/inspo/synara/packages/contracts/src/browserAnnotations.ts) and [coordinator tests](C:/Users/basin/inspo/synara/apps/desktop/src/browserAnnotations/coordinator.test.ts) | Extend the single-element picker with numbered markers and a comment per element. Bind captures to the session, tab, and document, so a navigation cannot attach stale page context. Useful for “align these three controls” or comparing several UI defects.                                                         |

My suggested sequence is persistent drafts, diff feedback, then project commands. They improve daily work and build on features BeddCode already has. PR checkout and background status make a good next Git-focused batch.

## Reliability patterns worth adapting

- **Durable command identities and recovery:** T3 separates [command receipts](C:/Users/basin/inspo/t3code/apps/server/src/orchestration-v2/CommandReceiptStore.ts) from a [durable effect outbox](C:/Users/basin/inspo/t3code/apps/server/src/orchestration-v2/EffectOutbox.ts). BeddCode already replays events after reconnecting, but a lost response can leave the client unsure whether a mutation happened. Persist operation IDs and outcomes in SQLite, and reconcile interrupted external operations before retrying. This does not make Git or provider calls automatically exactly-once; those need operation-specific recovery checks.
- **Recorded provider fixtures:** T3's [transcript replay tooling](C:/Users/basin/inspo/t3code/packages/provider-testing/src/replayTranscript.ts) is a good fit for testing provider upgrades. Keep sanitized real Claude, Codex, and ACP event recordings, then replay cancellation, approval, reconnect, and malformed-output cases through BeddCode's own adapters. This is already an open item in PLAN.md.
- **Bounded live output:** T3's [live-stream budgets](C:/Users/basin/inspo/t3code/apps/server/src/orchestration-v2/LiveStreamBudget.ts) make slow consumers explicit. BeddCode already has terminal backpressure; apply similar byte budgets and paged history to long agent conversations so a remote reconnect does not load an entire transcript at once.
- **Worktree-aware checkpoints:** T3's [restore safety checks](C:/Users/basin/inspo/t3code/apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts) reject restoring files in shared workspaces. A future “undo this turn” should separate conversation rewind from file restore, require an isolated worktree for restoration, and check for manual changes and other sessions immediately before writing files.

Durable requests and provider fixtures are the strongest stability investments. Neither requires adopting T3's Effect-based architecture.

## Keep the existing foundation

Keep native Claude/Codex adapters, Node/SQLite, React/Zustand, xterm, and the current host model. These references do not establish that a framework, terminal renderer, or database rewrite would be more reliable for BeddCode. Transfer focused behavior and recovery tests first.

The browser embedding layer deserves a separate compatibility investigation later. Electron currently [recommends alternatives to the webview tag](https://www.electronjs.org/docs/latest/api/webview-tag), including WebContentsView. That is a reason to evaluate focus, popup handling, layout, and capture behavior behind a browser abstraction, not evidence that replacing the current pane immediately will solve a demonstrated bug.
