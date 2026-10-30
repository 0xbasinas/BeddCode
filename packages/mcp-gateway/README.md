# BeddCode remote MCP gateway

This is a separate Cloudflare Worker. A BeddCode host dials it over WebSocket; MCP clients use
Streamable HTTP at `/mcp`. The Worker reads requests and results. It is a trusted gateway, unlike
the existing end-to-end encrypted relay. This first version connects one host to each deployment.

## Deploy and set secrets

From the repository root, with Wrangler logged in:

```powershell
wrangler deploy --config packages/mcp-gateway/wrangler.toml
```

Choose a strong client password and a different strong host secret. Set the Worker secrets without
putting them in command history. Both commands prompt without echoing what you type:

```powershell
wrangler secret put MCP_PASSWORD --config packages/mcp-gateway/wrangler.toml
wrangler secret put HOST_SECRET --config packages/mcp-gateway/wrangler.toml
```

The endpoint is disabled until both secrets are set. Wait briefly for a secret change to propagate.
Both secrets are bearer credentials; anyone holding the client password can instruct agents. Do not
put either secret in a URL, repository, or shared log. Rate limits slow guessing but cannot make a
weak password safe.

## Connect a BeddCode host

In the desktop app, open **Settings → Remote MCP**, enter the Worker address and host secret,
and select **Connect**. External agents can use `list_projects` to see every project added to that
host and must select one when starting a session.
The settings show the connection
status and a copyable MCP URL. The host secret is stored in the host's data directory and is not
shown again in the app. Disconnecting clears the saved connection and secret.

Alternatively, on the machine running the host, set these environment variables before starting it. Replace the
address with your deployed URL and use the same host secret you entered above:

```powershell
$env:BEDDCODE_MCP_GATEWAY_URL = 'wss://YOUR-WORKER.workers.dev/host'
$env:BEDDCODE_MCP_HOST_SECRET = Read-Host 'Host secret'
pnpm --filter @beddcode/server start serve
```

`Read-Host` displays what you type. To avoid displaying it in PowerShell, use:

```powershell
$secureHostSecret = Read-Host 'Host secret' -AsSecureString
$env:BEDDCODE_MCP_HOST_SECRET = [System.Net.NetworkCredential]::new('', $secureHostSecret).Password
```

These variables apply to the process started in this terminal. If BeddCode starts a separate host
as a service or from the desktop, configure its process environment and restart that host. Do not
start two hosts against the same gateway: the latest connection replaces the previous one.

The external agent must select a project added to the host. The project is not an OS sandbox. Agents may have other
access permitted by their provider and operating system. The gateway selects an advertised asking
or read-only permission mode, but providers differ in their enforcement. The host rejects agents
that do not advertise such a mode. Sessions are labeled `MCP:` in BeddCode. Authorized clients can
list, read, message, and interrupt all local sessions, including sessions not created through the gateway. MCP session IDs persist in the host's
data directory across restarts. Sessions started through the gateway are marked Remote MCP in the
thread and MCP in the sidebar. Clients can read full session history, answer questions, and allow or reject individual approvals. They can also inspect Git changes and read text files in an explicitly selected added project. Project reading and remote approval decisions are enabled by default and can be disabled in Remote MCP settings. All authorized clients share these permissions; the Worker and client can see the returned content.

## Connect and test

In a client that supports remote Streamable HTTP and OAuth, enter this URL and choose OAuth:

```text
https://YOUR-WORKER.workers.dev/mcp
```

When the client opens the BeddCode consent page, check the client and callback host, enter your
`MCP_PASSWORD`, and choose Allow. The authorization server supports automatic client registration
and PKCE. Clients requiring a manually registered client ID must supply their exact callback URI;
do not invent a redirect URI. Authorization metadata is available at
`https://YOUR-WORKER.workers.dev/.well-known/oauth-authorization-server`.

Clients that support custom authorization headers can alternatively use:

```text
URL: https://YOUR-WORKER.workers.dev/mcp
Authorization: Bearer YOUR_MCP_PASSWORD
```

To check direct bearer access with PowerShell, use the client password you set above:

```powershell
$secureMcpPassword = Read-Host 'MCP password' -AsSecureString
$mcpPassword = [System.Net.NetworkCredential]::new('', $secureMcpPassword).Password
$headers = @{ Authorization = "Bearer $mcpPassword"; Accept = 'application/json, text/event-stream' }
$body = @{ jsonrpc = '2.0'; id = 1; method = 'tools/list' } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri 'https://YOUR-WORKER.workers.dev/mcp' -Method Post -Headers $headers -ContentType 'application/json' -Body $body
$body = @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'; params = @{ name = 'list_agents'; arguments = @{} } } | ConvertTo-Json -Depth 8 -Compress
Invoke-RestMethod -Uri 'https://YOUR-WORKER.workers.dev/mcp' -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

`tools/list` works without a connected host. `list_agents` returns an offline error until the host
has connected. Start calls return a session ID; poll `get_session` for status. A timeout or dropped
connection may leave a session running, so check BeddCode before retrying a start. Do not assume
that a timed-out request was cancelled.

If the host is briefly disconnected, the Worker waits up to 12 seconds for it to reconnect before
returning an offline error. Calls already sent when the host drops are never replayed. `GET /status`
(same authorization as `/mcp`) reports whether the host is connected and when it last connected or
disconnected.

Mutating tools accept an optional `request_key`: retrying with the same key within 10 minutes returns
the first result instead of repeating the action. Read-only tools are retried once automatically if the
host drops mid-call.

The host checks the connection with WebSocket heartbeats and reconnects after interruptions. If a
second BeddCode host connects to the same Worker, it takes over and the first host stops retrying;
select Connect in its settings to switch back. Interrupted operations are not retried automatically.

External clients can use `list_sessions` to discover sessions and `get_session_events` to read the
history. Pass its `next_cursor` back as `cursor` to continue reading; `has_more` indicates whether
another page is immediately available. `get_pending_requests` shows questions and approvals;
`answer_question` and `resolve_approval` act on a specific pending request. Persistent approval
choices such as "always allow" are not accepted by the remote approval tool.

Use `list_projects` to choose a project, then `project_status`, `project_diff`, or
`read_project_file` with that project and a project-relative path. Reads and diffs over 180 KB return
an error; binary files are not returned by the file-reading tool. Do not put credentials in files or
sessions you do not intend to share with all clients authorized to the gateway.

Use `get_agent_options` to see an agent's available models, reasoning efforts, settings, modes,
commands, and skills before starting a session. `start_session` accepts optional `model`, `effort`,
`mode`, and `config` values. Use `get_session_options` to inspect a running session, then
`set_session_model`, `set_session_config`, or `set_session_mode` to change supported choices.
Remote mode changes are limited to asking or read-only modes. Not every provider supports changing
models or effort in an existing session. Use `rename_session` and `set_session_done` to organize
sessions without stopping them.

Rotate either secret with `wrangler secret put`; restart the host with the new host secret after
rotating it. To disable remote access, delete either Worker secret or stop the host. This version has
one shared client password and no per-client scopes or audit identity. Changing the password does
not invalidate OAuth grants already issued. OAuth clients can revoke tokens at `/oauth/token`;
to invalidate all grants, clear the dedicated OAuth KV namespace or replace it with a new one.
