# In-session switching notes

## Done

- Added a durable `session.switched` event schema and a client replica projection for ordered provider segments. Existing session creation events project to one initial segment; native provider session IDs and model changes update the active segment.
- Extended the existing handoff prompt builder with optional pending-message and diff inputs and a hard character limit. Added tests for segment replay and bounded context.
- Added the shared `SessionSegment` contract and event projection, used by both the host event store and client replica. The host reconstructs ordered segments from the durable log, including native IDs, model changes, switch timestamps and handoff context; older sessions get an implicit initial segment. Session metadata reflects the latest provider. Bumped the client snapshot version so cached projections replay with the new shape.
- Verified the host projection and client replay against a reopened SQLite event log, including a legacy session and multiple switches. `pnpm typecheck`, the server segment test, and the client handoff and replica cache tests passed (Turbo reported read-only cache warnings).

- Implemented the host `session.switchAgent` RPC. It checks provider readiness, refuses an active turn unless asked to stop, closes pending approvals with a transcript notice, stops the old process, builds a bounded handoff from the session projection and working-tree diffs, and starts the destination in the same folder. Failed starts return the draft and attempt to restore the previous provider. The handoff is delivered as a hidden prefix on the next user prompt; its pending delivery and the active segment survive host restart.
- Added host tests for switching, busy refusal, rollback and restart, plus a fake-provider RPC integration test. Workspace typecheck, server switch/transport/segment tests and client handoff/replica tests passed. Turbo reported read-only cache warnings.
- Switch-back now resumes the most recent earlier native provider session when supported, and builds its handoff from events after that segment ended using log order. Unsupported, missing, or failed resumes start fresh with full context; a provider reporting a lost conversation after prompting also receives full context on recovery. The resumed native ID and pending handoff are recorded for restart. Added delta formatting and fallback tests and an A→B→A fake-provider integration test.

- Added desktop/web session-header switching with ready-agent and model choices, a command-palette action and `/switch <agent>`, a stop-or-wait choice for busy turns, and an opt-in editable handoff preview. The host prepares the preview with its existing handoff builder and sends the reviewed text when supplied. Composer drafts survive cancellation and failures.
- Added the mobile agent/model picker and expandable switch markers on both clients. Switch events project into their original transcript positions, survive snapshot replay, and appear in exported transcripts. Added replay and reviewed-handoff tests; bumped the snapshot version.
- Verified workspace typecheck, mobile typecheck, focused replica/cache and switch tests, and oxlint on changed UI files. The local web app loaded without page errors; no connected host was available to exercise the switching flow in the browser. Expo lint could not run because its cache directory is read-only in the sandbox.

- Replaced the loose-prose handoff with one structured builder (`handoffPrompt`): labelled `##` sections (reason, goal, plan, decisions, changed files with `+N/-M` and the first hunk header, recent turns, pending message), empty sections omitted. Over the cap (6000 chars) it trims older turns, then hunk headers, then decisions, plan and file lines, marking sections `(trimmed)`; reason, goal and pending message are never dropped. Decisions are heuristic (assistant lines starting "Decided/Decision/Going with…").
- Switch-back to an agent with an earlier native segment that can resume sends a delta note (`# Handoff update`: reason, files changed since, turns by the other agent, pending message; no goal). Otherwise the full note. The preview shows whichever will be sent. Covered by the A→B→A fake-provider test and the unsupported/lost-resume fallbacks.
- The web and mobile switch markers render the sent note by section (`parseHandoffNote`); the review step edits the same text. The manual and automatic web handoffs use the same builder (patches are summarized, not pasted).

## Left

- Review the budget policy so essential context remains useful even with oversized fixed fields.
- Broaden provider process recovery coverage across restarts.
