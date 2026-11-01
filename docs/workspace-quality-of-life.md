# Workspace quality of life

Changes on `codex/workspace-quality-of-life`, November 2026.

| Linear issue | Behavior                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0XB-29       | Choose queue or steer while busy; edit queued text with conflict detection; reorder using drag and drop or buttons. Queue edits and ordering survive host restart. Desktop shortcuts: Ctrl/Cmd+Enter queues; Alt+Enter steers when supported. Mobile offers queue/steer choice, edit, move, remove and send now. |
| 0XB-38       | Restore attachment references alongside unsent desktop/web drafts. Verify each reference on its owning host before sending. Missing files and interrupted uploads require removal and reattachment.                                                                                                              |
| 0XB-39       | Save session notes on the owning host, with explicit save, version checks and conflict resolution. Existing browser notes remain local drafts until saved. Desktop/web persists unsaved drafts locally; mobile retains them while the screen stays open. Notes do not enter agent prompts.                       |
| 0XB-40       | Select failed CI runs/check groups, review and edit their context, then append it to the session draft. Capture PR head, run identity and SHA; check the current PR head before adding and require acknowledgement for stale context. Reading CI does not start an agent turn.                                   |
| 0XB-45       | Export Markdown or a TAR archive with Markdown, an export manifest and optional uploaded attachment bytes. List missing files and limits rather than implying complete inclusion.                                                                                                                                |
| 0XB-46       | Compare captured review fingerprints with current diffs before sending or attaching. Changed, missing and unverified diffs require explicit acknowledgement. Keep edited comments when a send fails or another edit arrives during sending.                                                                      |
| 0XB-48       | Inspect dirty files, active sessions, terminals and upstream comparison before worktree removal. Refuse dirty or busy worktrees and recheck before removal. Removing a worktree keeps its branch. Existing post-merge cleanup retains its separate branch choice and partial-result reporting.                   |
| 0XB-49       | Preserve conflicting editor drafts, compare the disk version, reload deliberately, or create a new copy without overwriting an existing file. Replacing a compared version checks that the disk has not changed again. A deleted original is a conflict.                                                         |
| 0XB-50       | Preserve the selected terminal per host/folder. Reconnect to surviving terminals, disclose retained-history limits and report unavailable terminals. Never rerun commands automatically.                                                                                                                         |

## Storage and export limits

Attachment draft storage contains IDs, names and sizes, never file bytes. Upload IDs resolve from their existing host directories after restart. This change does not introduce automatic upload expiration or delete files referenced by drafts. Removing a chip removes its draft reference; it does not delete the host upload.

Archive export covers the loaded transcript. It is a readable snapshot, not a provider session backup. Secret-question answers are masked; tools and messages are exported as shown, so review sensitive conversation contents before sharing. Attachment inclusion reads only stored uploads, with at most 100 unique attachments and 30 MiB of attachment bytes. Missing or excluded uploads are listed in `manifest.json`. Application settings and credentials are not read by export.

## Verification

- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- Prettier checks for changed files
- Web production build and desktop bundle
- `pnpm exec vitest run --config vitest.desktop.config.ts tests/desktop/workspaceQuality.desktop.test.ts`

The isolated Electron tests use a fake provider and real host RPCs, files, Git repositories and application storage. They exercise notes conflicts, attachment restore/send/export, stale comments, editor conflicts, queue edits, host restart and terminal recovery. CI UI tests substitute GitHub responses to test selection and changed-head handling without changing a real pull request. Mobile changes are typechecked and linted; physical-device testing remains necessary.

Larger items such as a task board, generalized durable jobs, offline mobile mutations, speculative execution and warm agent pools remain separate work.
