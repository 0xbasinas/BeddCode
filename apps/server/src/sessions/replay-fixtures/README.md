# Provider boundary replay fixtures

These are reconstructed, synthetic transcripts based on the message shapes exercised by the
provider session tests, not recordings captured from a live provider. They contain no user data.
They establish the replay harness; replace or supplement them with sanitized real recordings when
available. Do not describe synthetic examples as recorded failures.

- `claude-error.json`: Claude Agent SDK `SDKMessage` stream, SDK dependency 0.3.304;
  an execution error after session initialization.
- `codex-error.json`: Codex app-server JSON-RPC messages as understood by this checkout;
  a rejected `turn/start`. The app-server protocol has no version captured here.
- `acp-cancelled.json`: ACP JSON-RPC 2.0, protocol version 1 (SDK 2.0.0); a cancelled prompt.

The RPC fixtures map outgoing request methods to incoming response bodies. The harness supplies
request IDs from the adapter, just as a peer would. Claude's array is delivered through the SDK
query stream after a prompt. The host's `session.created` event is seeded separately; all turn
events come from the real session adapters. Projection replay includes a reconnect with overlapping
stored events. Codex also receives a malformed line before its response.

For future captures, record at the SDK query/callback or JSON-RPC transport boundary, preserve
message order and correlation IDs, and document provider, protocol and version. Replace secrets,
account identifiers, absolute personal paths and private prompts/output with consistent synthetic
values; review every field and any embedded strings before committing. Never commit raw captures.

## CI

`pnpm test:replay` runs only the replay test. The `Provider replay` workflow runs it when a provider
package, `pnpm-lock.yaml` (a dependency bump) or these fixtures change, so a provider SDK upgrade that
breaks an adapter fails before merge. The full `pnpm test` runs it too.
