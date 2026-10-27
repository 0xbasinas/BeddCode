# Performance improvements

Branch: `codex/performance-improvements`. Reviewed and implemented on 2026-10-27.

## Changes

| Area                   | Implementation                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server replay          | Read a fixed log prefix in chunks, yield between chunks, wait for socket backpressure, then deliver queued live events after the replay marker. Cancel timers and listeners on disconnect or resubscription. Bound the pending event count and serialized size. |
| Event storage          | Import each history turn in one SQLite transaction. Validate before writing, roll back the whole batch on failure, and notify subscribers only after commit. Live events retain their existing immediate durability.                                            |
| Shared replica         | Combine contiguous assistant deltas within a received batch. Preserve the first message ID, latest timestamp, final sequence cursor and immutable input state.                                                                                                  |
| Transcript preparation | Retain completed turn blocks while streaming, invalidate from the first changed turn, and group diffs with path maps.                                                                                                                                           |
| Snapshot saves         | Cache serialized immutable sessions, stop assembling oversized snapshots, and keep only the latest pending snapshot behind an in-flight write. The on-disk format remains compatible.                                                                           |
| Mobile storage         | Await the SDK 58 asynchronous file write so completion and rejection belong to the save operation.                                                                                                                                                              |
| Desktop rendering      | Cache the finished Markdown prefix during streaming, retain full-document parsing for reference definitions, and read diff totals already maintained by the replica. Preserve existing CSS content visibility.                                                  |
| Sidebar                | Defer message search, memoize its results, and append to project groups without copying the growing array for every session.                                                                                                                                    |
| Git polling            | Share a serial poller between web and mobile. Schedule the next poll after completion and collapse manual refresh bursts into one follow-up. Stop delivering results from disposed pollers.                                                                     |
| Git service            | Parallelize independent metadata commands and share simultaneous info/status reads for the same working directory. Completed reads are not retained as stale cache entries.                                                                                     |
| File browsing          | Stat up to 16 directory entries concurrently. Cache up to eight bounded path indexes for two seconds, invalidate on host watcher events and application writes, and share concurrent index builds.                                                              |
| Attachments and PDFs   | Await asynchronous directory/file operations instead of blocking the server or Electron main process.                                                                                                                                                           |
| Node relay             | Terminate persistently congested outbound sockets once their existing send backlog exceeds 32 MiB. Clients can reconnect and replay durable events.                                                                                                             |
| Relay metrics          | Calculate exact nearest-rank percentiles and daily groups in SQLite. Return aggregates rather than materializing all raw samples in JavaScript.                                                                                                                 |
| Mobile animation state | Bound remembered row animation IDs to 4,000 entries.                                                                                                                                                                                                            |

## Reproducible CPU comparisons

Run from the repository root:

```powershell
pnpm --filter @beddcode/server exec tsx ../../scripts/benchmark-performance.ts
```

Windows, Node v24.22.1. Median of seven measured runs after a warmup. The script checks equivalent results before measuring and consumes the serialized bytes.

| Synthetic workload                                              |                   Previous operation |                        Improved operation |
| --------------------------------------------------------------- | -----------------------------------: | ----------------------------------------: |
| Apply 1,000 contiguous assistant deltas to 2,800 existing items |                              6.41 ms |                                   0.07 ms |
| Prepare 100 transcript updates across 400 turns and 2,000 diffs |          29.12 ms with full rebuilds |         3.82 ms with retained turn blocks |
| Encode a warm snapshot of 120 unchanged sessions                | 2.22 ms with full JSON serialization | 0.89 ms with cached session serialization |

These measure specific CPU operations, not overall app speed, frame rates, mobile device performance, network latency or disk throughput. Actual results depend on history size and batch size.

## Verification and limits

| Check                   | Result                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Repository typecheck    | All 12 packages passed, including mobile and the relay worker.                                        |
| Server regression suite | 45 files passed, 418 tests passed, two skipped, using two workers.                                    |
| Client runtime          | 216 tests passed.                                                                                     |
| Web                     | 117 tests passed, including Markdown rendering equivalence.                                           |
| Desktop                 | 61 tests passed.                                                                                      |
| Relay                   | 16 tests passed, two skipped.                                                                         |
| Production builds       | Web/Vite and Electron/esbuild passed. Existing bundle-size and dependency annotation warnings remain. |
| Lint                    | No errors; existing repository warnings remain. Mobile source lint passed.                            |
| Formatting              | Changed performance files checked with Prettier; `git diff --check` passed.                           |

Integration tests require loopback networking and normal temporary-file access. An unrestricted full run passed before the final additions. A later concurrent run hit one Windows PTY directory-cleanup lock; the complete server suite then passed with two workers. No terminal implementation or test cleanup behavior was changed to suppress that failure.

Regression coverage includes replay/live ordering with and without compaction, stalled and cancelled replay, transaction rollback, batch replica equivalence, incremental block equivalence, snapshot updates and slow saves, serial polling, search invalidation, Markdown rendering equivalence, and SQL percentile equivalence.

The larger changes from the review remain profiling candidates: moving SQLite or snapshot serialization into workers, storing each session separately on disk, and replacing desktop content visibility with full viewport virtualization. This branch reduces the current work without changing those storage and layout designs. Cloudflare runtime load testing and release-build profiling on a physical phone remain separate checks.

The original review described the phone's file write as synchronous. SDK 58's installed types and [versioned documentation](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) confirm that `File.write` returns a promise. This branch awaits that existing asynchronous operation. Desktop transcript content visibility was also already present and is retained.
