# PRD: Extend remote MCP agent workflows

Status: Draft for discussion  
Date: 2026-10-28  
Scope: BeddCode's remote MCP gateway and desktop host

## Problem

An external agent can start and send messages to a BeddCode agent, but it must remember the session ID and can see only the latest reply and a short waiting description. After a reconnect or a long task, it is difficult to find the session, understand what happened, or help when the agent asks a question. The user wants the remote MCP connection to do more useful work without adding a complicated setup.

This problem is inferred from the current product and the user's request. We do not yet have usage data or interviews to quantify it.

## Current product

The Cloudflare Worker exposes `list_agents`, `list_projects`, `start_session`, `get_session`, `send_message`, and `stop_session`. Starting a session requires an explicitly selected project already added to the host. Session operations are limited to sessions started through the gateway, with their IDs stored on the host. `get_session` returns a digest including the latest reply and what the session is waiting for, not a full timeline.

The host already records session events and has internal APIs for answering questions and inspecting Git status and diffs. Those internal APIs are not currently exposed through the remote gateway. The Worker can read remote requests and results, and the gateway uses a shared password or OAuth; it does not provide a distinct identity or scope for each client. An asking or read-only provider permission mode is selected for sessions started through the gateway, but provider behavior differs and a project folder is not a sandbox.

## Goals

1. Let an external client rediscover gateway-created sessions after a reconnect without the user saving IDs manually.
2. Give the client enough context to follow a multi-step task and identify when a person needs to act.
3. Let the user inspect project changes and see questions and approvals that need attention.
4. Let the user choose whether an external client can answer ordinary agent questions, with approval decisions handled separately.
5. Keep the connection simple and preserve existing tools, explicit project selection, and safe handling of interrupted requests.

## People and key stories

- As a person using Grok or another MCP client, I want to find the local agent session I started earlier so that I can continue it after reconnecting.
- As a remote agent, I want recent session progress and the latest result so that I can report what happened without asking the local agent to repeat itself.
- As a person, I want to know when a session is waiting for an answer or a local approval so that I can unblock it in the appropriate place.
- As a person who opted in, I want my external agent to answer a local agent's ordinary question so that a routine task can continue.
- As a person, I want to review a project's changes and decide what happens next before asking an agent to modify them further.

## Recommended release: P0

The first release balances finding and following sessions, reviewing project changes, and handling questions and approvals. It includes optional answers to ordinary questions and makes approvals visible for action in BeddCode. Remote approval decisions are a proposed follow-up pending the trust-model decision below. Proposed tool names and schemas are design starting points; keep existing tool names and behavior compatible.

### 1. Find gateway sessions

Add `list_sessions`, returning gateway-created sessions on the connected host, including ID, title, project, agent, current status, last update time, and a short indication of what needs attention.

Acceptance criteria:

- [ ] With no matching sessions, return an empty list with a clear response.
- [ ] Support optional project and status filters and pagination using an opaque cursor; order by most recent activity with a stable tie-breaker.
- [ ] A session remains discoverable after a host restart when its existing event history is available; unavailable or deleted history does not break the entire list.
- [ ] Sessions created outside the gateway are excluded, even if the caller guesses their IDs. Existing gateway-created sessions remain accessible under their existing scope.
- [ ] An offline host produces an actionable error and does not pretend an empty list is a successful result.

### 2. Follow progress and results

Add `get_session_events` for a bounded, paginated view of recent user and agent messages, turn status, tool progress summaries, and questions or approval requests. Continue to support `get_session` as the quick summary.

Acceptance criteria:

- [ ] The caller can fetch an initial page and subsequent events using a cursor. Responses identify the session and whether more events are available.
- [ ] Events preserve their ordering and expose stable IDs or positions so clients can deduplicate after reconnecting. If the cursor is invalid or no longer available, return a clear error and recovery instruction.
- [ ] Include current terminal status and a result or error when available; distinguish a running task, an idle task, an interrupted task, and one waiting for the user.
- [ ] Bound page size and response bytes; indicate truncation or continuation instead of silently presenting partial text as complete.
- [ ] Do not expose raw terminal output, file contents, tool arguments, credentials, or unrelated session data by default. Agent messages and summaries remain untrusted content and must be labeled as such.
- [ ] A reconnect may repeat a read; fetching events does not change the session or duplicate an operation.

### 3. Show and answer agent questions

Add `get_pending_requests` and `answer_question` for gateway-created sessions. A question is an ordinary information request from the agent; a permission or tool-execution approval is a separate request type.

Acceptance criteria:

- [ ] Pending questions include session ID, request ID, question text, available choices, and whether free text or multiple selections are accepted, as supported by the provider.
- [ ] Pending approvals identify the session, request, title, and available decision labels when supported, and clearly say that the decision must be made in BeddCode. They cannot be resolved remotely in this release.
- [ ] Answering questions remotely is disabled by default and can be enabled or disabled in Remote MCP settings. The UI explains that every client with access to this gateway can use the enabled capability.
- [ ] Only a currently pending question on a gateway-created session can be answered. Reject invalid choices, stale or already answered requests, disabled access, and unsupported providers with clear errors.
- [ ] An accepted answer appears in the local session history. If the connection drops before the reply arrives, return an outcome-unknown error and instruct the caller to refresh pending requests before retrying.
- [ ] Existing local question handling and local approval controls continue to work.

### 4. Review project changes

Add read-only project inspection for an explicitly selected added project: branch and working-tree status, changed-file list, and bounded diffs. The external client can summarize changes and suggest a follow-up to an agent.

Acceptance criteria:

- [ ] The caller selects an existing project; no implicit default project is introduced. Non-Git projects and unavailable hosts return useful errors.
- [ ] Only project-relative paths returned by status can be requested. Path traversal, symlink escapes, and paths outside the chosen project are rejected at use time.
- [ ] Diffs and file lists are paginated or explicitly truncated and identify binary and oversized files. Untracked-file handling is specified before implementation.
- [ ] This capability is read-only: no staging, committing, resetting, shell execution, or arbitrary file reads. Git status and diffs may contain sensitive information, so make remote sharing an explicit desktop setting before enabling it.
- [ ] Preserve MCP tool compatibility and test repositories with no changes, staged and unstaged changes, untracked files, binary files, and path edge cases.

### 5. Reliability and compatibility

- [ ] Existing clients can still discover and call all six existing tools with their current inputs and outputs.
- [ ] New tools publish accurate descriptions and JSON schemas. Unsupported operations and offline hosts produce actionable MCP tool errors.
- [ ] Do not automatically replay any mutating request after a timeout or reconnect. A caller must inspect current session state before retrying.
- [ ] Preserve explicit project choice and the existing single-host connection model.
- [ ] Test locally with a real Worker and host, including disconnects while reading and while answering a question, and validate at least one real external MCP client.

## P1: Remote approval decisions

If the user wants the external client to resolve approvals as well as see them, add that as a separate opt-in capability after agreeing on a trust model. This should use the existing pending approval and its exact choices, not grant the client a general bypass. A shared password or OAuth grant gives access to every authorized client; it is not proof that a particular human is making the decision.

Acceptance criteria:

- [ ] Remote approval decisions remain disabled until the user explicitly enables the capability and understands that all clients authorized to the gateway can use it.
- [ ] Show the exact request, context, and provider-supplied choices before accepting one. Only a still-pending request in an eligible session can be resolved; stale or unknown choices fail clearly.
- [ ] Record accepted decisions in local session history. On an interrupted response, report an unknown outcome and inspect the current request before retrying.
- [ ] Local approvals continue to work, and no global auto-approve mode is enabled by this feature.

## Architecture direction

Keep the existing topology: the external MCP client calls the Cloudflare Worker, which forwards an allowlisted tool request over the host connection. The host checks the gateway-owned session list and the user's settings before reading or changing session state. Extend the existing narrow gateway protocol for each new tool; do not expose the host's generic RPC interface.

For discovery and progress, derive bounded responses from stored session events. Stable event cursors and pending-question reconstruction need investigation before their exact format is chosen. The Worker relays those responses without becoming the source of truth. A host restart, changed event retention, or an invalid cursor must be visible to the caller rather than quietly skipping events.

For question answers, the host verifies the gateway setting, ownership, provider support, request identity, and current pending state before using the existing answer API. The Worker and host return an outcome-unknown result if the connection breaks after dispatch. The client reads pending state before deciding whether to retry; this release does not promise exactly-once delivery.

The Worker and host are deployed independently, so additions must tolerate a newer Worker talking to an older host and vice versa. An unsupported new tool must return an actionable error; existing tools remain available. The transport continues to use the existing host secret and client authentication, and both request and response sizes need enforced limits.

## P2: Later opportunities

- **Attach an existing local session:** useful for delegating a task already underway, but requires a per-session sharing decision and clear controls over which existing conversations a remote client can see or change.
- **Richer project artifacts:** summaries of test results, changed files, and proposed patches, with clear size limits and explicit sharing.
- **Per-client access:** identify clients and grant or revoke capabilities individually; this is especially valuable before exposing broader existing-session access or remote approvals.
- **Notifications and multiple hosts:** reduce polling and let a user choose among computers, once the single-host workflow is proven.

## Non-goals for P0

- No generic host RPC, unrestricted filesystem browser, arbitrary terminal, or external direct write access: these substantially expand what a remote client can do.
- No access to all existing local sessions: the gateway currently limits visibility to its own sessions.
- No remote approval of tool calls, commits, pushes, deployments, or other actions requiring user approval.
- No default project or automatic selection of a project.
- No new authentication system, multiple-host routing, or mandatory external account.

## Privacy and permission model

The desktop host remains authoritative for session eligibility and settings; the Worker must not be able to bypass those checks. Project and session content sent through MCP is visible to the Worker and external client. A shared client password and OAuth grants do not identify a specific human reliably, so opt-ins apply to every client authorized for the gateway. Existing provider and OS permissions continue to apply; none of the proposed controls turns a project folder into a sandbox.

Responses should contain only the information needed for the requested feature, bounded in size. Do not add telemetry containing prompts, answers, paths, diffs, or credentials without a separate product decision. Where an action's outcome is uncertain, explain that state rather than claiming it was cancelled or retrying it automatically.

## Success measures

These are proposed validation targets, not measured baselines or guarantees. Collect measurements through opt-in test sessions or manual evaluation; do not assume a telemetry system exists.

| Measure                           | Proposed target                                                                                       | How to check                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Recover a session after reconnect | 5 of 5 scripted sessions can be found and continued without a saved ID                                | Acceptance test with one host and one client         |
| Follow progress                   | 5 of 5 scripted sessions show ordered progress and an accurate current status                         | Compare MCP output with local event history          |
| Handle a question                 | 5 of 5 supported questions can be answered once when enabled; all attempts are rejected when disabled | Provider integration tests and a real-client trial   |
| Review project changes            | 5 of 5 test repositories report the expected changed files and bounded diffs                          | Compare MCP responses with Git and host results      |
| Recognize approvals               | 5 of 5 pending approvals show the correct session and require local action                            | Provider integration tests and a real-client trial   |
| Avoid repeated actions            | Zero automatic repeats of mutation requests in disconnect tests                                       | Fault injection around request delivery and response |
| Usability                         | A user completes find, inspect, and continue in under 2 minutes in 4 of 5 observed trials             | Timed manual trial after initial connection          |

Review results after the first five real-client trials; revise targets when a baseline exists.

## Dependencies and rollout

1. Confirm the event-store APIs can provide stable pagination and reconstruct pending questions across reconnects. If not, design that support before promising reliable cursors.
2. Define a minimal event projection and question schema that works across supported providers, including providers that lack question support.
3. Deliver P0 behind the existing remote MCP configuration, with remote question answers and project-change sharing disabled until the user opts in.
4. Test with the local Worker, host, a representative provider, and Grok or another real MCP client. Roll out host and Worker versions together; older clients must keep working.
5. Evaluate the workflow and decide whether remote approval decisions should proceed in P1. No deadline has been provided.

## Open decisions

- **User / product:** Should an external agent be allowed to make approval decisions when explicitly enabled, or should those always be resolved by a person in BeddCode? The first release assumes local decisions; P1 describes the remote option.
- **User / product:** Should ordinary question answering be enabled per gateway, per session, or both? The draft assumes one gateway-wide opt-in.
- **Engineering:** Can the current event log provide durable, stable cursors and pending-request state for all supported providers after a host restart?
- **Engineering / product:** What should happen to gateway ownership records when sessions are deleted, imported, or copied? Existing records must not silently broaden access.
- **Product / design:** What is the clearest distinction between an informational question and a permission approval when a provider uses custom request types?
