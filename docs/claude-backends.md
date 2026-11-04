# Claude backends

BeddCode can run Claude through the Claude Agent SDK or the Claude CLI. The SDK is the default: it is bundled with BeddCode and provides in-process control with fewer moving parts. The CLI runs the installed `claude` executable and uses its version, authentication, settings and plugins. New CLI features can arrive there first. In CLI sessions, approvals go through a small MCP bridge (except when permissions are bypassed).

Set the host default with `beddcode config set claude-backend cli` or `beddcode config set claude-backend sdk`, then restart the host. In Settings → Agents, choose a project under Project Claude backend to override the host default or select Use host default.

## Known gaps

- Host backend settings are not yet exposed through the web RPC, so the host default cannot be changed in the web UI and the agent picker cannot identify CLI when it is inherited from the host.
- The project picker label currently reflects an explicit project override only.
- CLI availability depends on a compatible installed `claude` executable and its authentication. CLI behavior and supported features depend on that installed version.
- Changing effort during a running CLI session is not currently supported.
