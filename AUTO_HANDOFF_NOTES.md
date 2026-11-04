# Automatic handoff: first version

## What works

- The web app watches new normalized provider error events after the host is synchronized. It recognizes common limit, context, authentication and availability messages for Codex, Claude, Grok, ACP (including Goose), pi, OpenCode and the fake provider, and treats three reported generic failures as a trigger.
- Agents settings provide a host-wide mode and ordered fallback list, plus project-specific overrides. Off is the default. Ask gives a ten-second cancel countdown; auto starts immediately. Only configured, ready agents are selected, with a hop limit and a 30-minute failed-agent cooldown.
- The existing handoff packet builder and working-tree capture supply the continuation. The reason is appended. The new session uses the existing `handoffFrom` path and the same working directory. A durable forward event gives the source a link to the destination and reason; web and mobile show the links.
- If creation or sending fails, the packet is kept in browser drafts, including the source session's composer when it was empty. A successfully created destination also receives the packet as a draft before sending.
- Concurrent automatic creation requests for the same source now share a server-side in-flight request, and retries return a recorded destination. The client uses a stable message ID for the first prompt, subject to the host's existing ten-minute in-memory deduplication window. Ancestor cooldown timestamps now follow each link in the chain.

## Remaining work and limitations

- **This is still client-driven, not unattended host automation.** A web/desktop window must remain open and connected. Settings are browser-local, not shared across devices. Errors while the client is offline, during initial synchronization, or while another handoff is being processed may be missed. The creation guard does not provide a durable atomic claim across a host crash, and prompt deduplication expires. Move orchestration, policy, failure history, countdown and a durable atomic claim/idempotency key to the host before relying on this for unattended work.
- Detection uses normalized error text and common provider-specific phrases, not structured native error codes. Some adapter errors, provider start/sign-in failures before a session exists, turn-completion-only failures, and provider status changes are not observed. The repeated-error count is session-wide rather than a bounded consecutive-error window. Add native mappers and fixtures from each provider's actual streams.
- A failed target start does not automatically try the next candidate. A created session whose first prompt fails needs manual recovery. Cancellation after the countdown is disabled once creation starts; there is no editable automatic-handoff dialog. The packet is generated at execution time, so canceling the countdown does not create a packet to edit.
- Cooldown and hop history are reconstructed from visible session links, and can be incomplete if ancestors are unavailable or deleted. Project overrides cannot yet be removed to resume inheritance. The cooldown duration is fixed in the interface.
- Markers currently appear in the session header (and mobile transcript header), rather than at their exact position in the transcript. Mobile cannot configure or initiate automatic handoff.
- Unit coverage includes trigger phrases and policy selection; host tests check durable links and concurrent creation requests. Full fake-provider end-to-end flow, cancellation, reconnect, multi-client, and failure-recovery tests remain to be added.
