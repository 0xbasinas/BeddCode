# Hosts and settings reference

Commands and explanatory notes that used to be shown inside the desktop app's Hosts and Settings pages. The UI now stays short; the detail lives here.

## Hosts

### Run a host on another computer

Both computers must be able to reach each other, typically through the same Tailscale network. On the computer that will act as the host, from its BeddCode checkout (dependencies installed):

```sh
# Keep the host running in the background
pnpm --filter @beddcode/server start install-service

# Create a one-time pairing code
pnpm --filter @beddcode/server start pair
```

Keep the checkout and its dependencies in place while the host is running.

### Pair from this computer

1. In Settings → Hosts (or the sidebar host menu), choose **Add host**.
2. Pick a discovered host, or type a machine name / IP address. The default port is `3773`; add `:port` for another one. A full URL such as `http://build-server:3773` also works.
3. Enter the 6-digit code from the other computer and choose **Pair and connect**.

Pairing codes work once and expire after 10 minutes. If a host refuses the pairing, create a fresh code on it and pair again.

### Let another computer connect to this PC

Settings → Hosts → **Share this PC** shows this computer's address and a one-time pairing code, and lists the devices already paired. **Revoke** closes a device's active connections immediately; it needs a new code to return. The local host must be running and accepting remote connections (`install-service` above).

### Behaviour notes

- Hosts use Tailscale or another reachable network, and each remote device must pair.
- Sessions keep running on their host when you close the app.
- BeddCode reconnects to every saved host on launch; this is not configurable.
- Discovery only lists hosts on your tailnet. If it is unavailable, enter the address by hand.
- Removing a host only forgets it locally; you can pair with it again later.

## Agents

- Claude and Codex keep their own login. Run the login command in a terminal on the host, then refresh the agent list:
  - Claude: `claude auth login`
  - Codex: `codex login`
- Other agents are installed and signed in with their own CLI on the host.
- The scripted test agent simulates messages, approvals and file changes without any CLI login.
- Custom ACP agents show their launch command (executable plus arguments) in the agent's own configuration.
- Registry agents use a pinned version and launch on the host when a session starts.
- Environment values for a custom agent are saved in that host's agent configuration file. Use the CLI's own login for account credentials.
- Defaults are saved in this app per host and apply to new sessions only; existing sessions keep their current choices.

## Permissions

- Each agent owns its permission modes and approval prompts.
- ACP agents may report their modes only after a session starts. For ACP agents that report none, BeddCode switches Grok with its own command and otherwise answers permission prompts with Allow; the choice applies when a session starts and can be changed in the session. Agents that do report modes offer their own choices on each prompt, such as allow once or always.
- Existing sessions keep their current mode.

## Editor

- Files save with Ctrl+S or the Save button.

## Usage

- Token counts come from what each agent reports after a turn, on that host. Agents that do not report usage (some ACP agents) do not appear.

## Other settings text removed from the screens

### General

- Each host keeps its own agent logins, folders and conversation history. The app reconnects to paired hosts on launch.
- Default host: where new sessions start.

### Appearance

- Interface font applies to labels, menus and conversation text.
- Density changes spacing in session lists, file trees and Settings.
- Reduce motion keeps pane and menu transitions still.

### Editor

- Font size and tab size apply to the built-in editor (JetBrains Mono).
- Line numbers show a number beside the code; word wrap fits long lines to the editor width.

### Git

- Default workspace: you can choose another workspace before starting each session.
- Isolated branches: a new worktree keeps an agent's edits apart from your main checkout. Folders without a Git repository use the folder directly.
- Commits use the host's Git configuration. Pull requests use its signed-in GitHub CLI. Pushes and commits run only when you click their buttons.

### Notifications

- Triggers: an agent needs you (a permission, question or plan waiting), a turn finishes, a host disconnects.
- Only when BeddCode is in the background skips alerts for the session you are looking at.
- Sound plays with each notification; quiet hours mute everything except an agent that needs you; Try it shows a sample notification.

### About

- Development build, Windows and Linux.
- Your data stays on each host: agent logins, project files and session history belong to the machine running the session.
- Saved agent defaults apply to new sessions in this app. Agent CLIs keep their own login and configuration.

### Page subtitles

- Permissions: choose what each agent may do without asking.
- Tools & MCP: MCP servers your agents can use, as each agent keeps them.
- Usage: what your plans have used, and where it went.
- Agents: which coding agents BeddCode can run, and how they behave in new sessions.
