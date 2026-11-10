# Shared vs device-local settings

BeddCode keeps one settings document on the host (`$BEDDCODE_HOME/host-settings.json`). Every connected app — the phone, the desktop app, and the web app — can read it, change it, and see other apps’ changes live. No reload is needed.

The wire methods are `settings.get` and `settings.update`. A `settings.changed` frame is sent to every connected client after a write. Each document has a `version` and `updatedAt`. Updates are a patch merged onto the current document (field-level last-write-wins). If a client sends a stale `baseVersion`, the patch still lands and the reply includes `merged: true` so the client can replace its copy.

If the host store is still empty (version 0) when a client first connects, that client may upload leftover local values so earlier desktop choices are not lost.

## Already on the host (unchanged)

These already have their own RPCs and stay there. They are shared across clients by design:

- MCP servers (`mcp.*`)
- Schedules (`schedules.*`)
- Project instructions (`projects.setInstructions`)
- Host alerts / ntfy (`alerts.settings`)
- Warm pool, relay, MCP gateway, Claude backend, orchestration settings

## Now shared (this host settings store)

- Default agent for the host, and per-agent model / effort / permission mode
- Automatic handoff: off / ask / auto, the next-agent list, hop limit and cooldown, including per-project overrides
- Approval mode for new work: off / ask / auto
- Theme (system / dark / light) — the phone itself stays dark, but changing theme on the phone updates desktop and web
- Default workspace for new sessions (worktree or local)
- Notification *event* prefs the host needs: needs you, turn done, error, schedule

## Stays on the device

- Which host this app is paired with, and the default host key in the desktop app
- Biometric lock, haptics, and this device’s push token
- Whether *this* phone wants push alerts at all (`enabled` on the phone)
- Notification sound, “only in background”, and quiet hours
- Interface density, fonts, reduce-motion, editor font / tab / wrap / line numbers
- “Warn when a turn runs long”
- Composer drafts, offline queue, and other per-device UI state

Pin, rename, and the session list live on the host already (session records), not in this settings file.
