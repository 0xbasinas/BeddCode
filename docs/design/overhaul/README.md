# Overhaul from peer apps (October 2026)

Ideas taken from looking at how monocode, trysynara, t3code and paseo handle a one-person setup
(several agents, several hosts over Tailscale, worktrees). Only the ideas were used; no code was
copied.

| Feature                     | Why it matters here                                                                                                       | Screenshot                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Proxy-aware host guard      | `tailscale serve` connects from loopback, so its clients used to look local. They now pair first; Funnel is refused.      | —                                                                               |
| Enter sends when ready      | Enter while the host or agent is still loading used to drop the message silently.                                         | `overhaul-enter-armed.png`                                                      |
| Turn changes and undo       | Every turn ends with what really changed in the folder (commands included), per-file diffs, and undo for the latest turn. | `overhaul-turn-changes.png`, `overhaul-undo-confirm.png`, `overhaul-undone.png` |
| Folder scripts              | One-click install/dev/test buttons in the Terminal pane; optional auto-run in new worktrees.                              | `overhaul-scripts.png`, `overhaul-scripts-editor.png`                           |
| Search inside conversations | Ctrl+K finds sessions by anything said in them and shows the matching words.                                              | `overhaul-search.png`                                                           |
| Pinned sessions             | Keep the few sessions you return to at the top, on every client of a host.                                                | `overhaul-search.png` (pin icons), sidebar in the others                        |
| Continue with another agent | Hands a session's summary to a new session with a different agent in the same folder.                                     | `overhaul-handoff.png`                                                          |

The screenshots come from a scratch host on port 3874 with real Claude Code, Codex and Grok
(`grok agent stdio`) sessions in a throwaway repository.
