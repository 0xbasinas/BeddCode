# End-to-end tests

Run `pnpm test:e2e` to build the web client and run the TesterArmy e2e suite. The framework documents WSL for Windows, although the suite has also been run on native Windows. The first run may download Chromium.

The runner starts a host on a free loopback port, with a temporary data directory and working folder. It enables the scripted fake agent and stops the host after the run. It does not use your normal BeddCode database or send prompts to real agents. The host also detects installed real providers; the tests must explicitly select the fake provider before sending any prompt.

The framework records test outcomes, step timings and failure traces in a new directory under `.e2e/runs/` for each run. Each directory also contains `junit.xml` and `summary.md`. These are test and interaction durations, not measurements of CPU, memory, throughput, or capacity. Compare runs on the same machine and build; do not treat a single timing as a performance guarantee. The e2e CLI has anonymous telemetry; set `E2E_TELEMETRY_DISABLED=1` when running it to disable that.

The tests cover first launch, host and fake-agent discovery, settings, draft navigation, streamed sessions, approval and denial, agent questions, cancellation, and session recovery after a reload. They do not stress 50 sessions, measure resource consumption, or test the Electron shell. A separate controlled load test is needed for those measurements.

## Real coding agents

`pnpm test:e2e:real` builds the web app and runs one short prompt each through Claude Code, Codex, and Grok. These tests are separate from `pnpm test:e2e`, use the CLI's existing authentication and usage allowance, and run sequentially with no automatic retries. Install and sign in to the CLIs first. The temporary BeddCode host registers Grok as `grok agent stdio`; it does not copy your BeddCode agent settings.

To run just one provider after building the web app, use:

```powershell
pnpm exec e2e run --config e2e.real.config.ts --tag codex
```

Replace `codex` with `claude` or `grok`. Reports are retained in `.e2e/real-runs/`. Each test checks the provider's response and waits for the turn to finish. Test duration includes UI and provider latency, not just model response time. Provider rate limits and network conditions affect it.

The host data and working folder are temporary. The prompt asks the agent not to use tools, but the test is not an OS sandbox: the CLI still has the user's permissions and may load its normal configuration or hooks. Never use this as a test of isolation or run it with untrusted agent configuration.

## Five concurrent real sessions

Run `pnpm test:e2e:concurrency` to run three load tests in sequence: five Claude sessions, five Codex sessions, then five Grok sessions. Each test creates five separate projectless folders in the temporary host, starts all five sessions, then sends a short prompt to all five concurrently. It checks that five turns overlap, finish successfully, and include the expected response. Each full run sends 15 prompts and uses the configured providers' allowances. It does not require approval requests or run a build inside the agent sessions.

To test one provider after building the web app, run `pnpm exec e2e run --config e2e.concurrent.config.ts --tag codex`. Use `claude` or `grok` for the other providers. The runner saves test reports under `.e2e/concurrency-runs/` and JSON plus a readable Markdown summary under `.e2e/concurrency-stats/`.

The report includes per-session outcomes, creation time, time to first assistant text, completion time, event and tool counts, and usage events when the provider reports them. It also summarizes timings and samples system-wide CPU and available physical memory approximately once per second. System samples include every process on the computer, so they cannot attribute usage to BeddCode or the agent CLIs. Usage and cost totals can be missing or partial, and are not billing records. Percentiles use nearest rank; with only five sessions the p95 is the maximum, not a stable estimate.

The report also measures prompt acknowledgement time and before/after WebSocket ping times to the local BeddCode host. These pings measure local host responsiveness, not internet or Wi-Fi latency. The test connection's WebSocket payload byte counts exclude framing, other connections, and provider traffic. Windows reports received and sent bytes for active network interfaces, including Wi-Fi, by subtracting OS counters around the workload; Linux uses `/proc/net/dev`. The report includes average bytes per second over that interval. These adapter numbers include all applications and background traffic. Virtual interfaces can overlap with physical traffic, so do not add them together. An unavailable or reset counter is omitted rather than treated as zero; macOS counters are not implemented.

These measurements cover a short text-only workload, not extended workloads or five simultaneous builds. The test talks to the host over WebSocket; it does not exercise five independent browser windows or the Electron shell. If the browser evaluation fails, a partial report preserves available system samples and the failure message.

## Concurrent code review workload

Run `pnpm test:e2e:realistic` to run a second, more representative scenario for each provider, one provider at a time. It creates five isolated temporary workspaces, puts a small TypeScript inventory function with a different bug identifier in each, and asks each agent to inspect its own file and explain the stock-underflow bug. Each run checks that all five turns overlap and complete, each agent uses a tool, its answer identifies the correct workspace's marker and the issue, and the fixture file remains unchanged. Codex uses its read-only mode; Claude uses its default approval mode; Grok uses ask mode. Unexpected approval or question requests stop the affected turn and fail the test.

To select one provider after building, run `pnpm exec e2e run --config e2e.realistic.config.ts --tag codex` (or `claude` / `grok`). Results are labeled `review` in `.e2e/concurrency-stats/`; the original short `PONG` tests are labeled `quick`. Test reports are under `.e2e/realistic-runs/`. Running all providers makes 15 real provider calls. The CLI credentials, settings, and hooks are the user's own, and the test is not a general sandbox. Checking that the fixture remains unchanged does not prove that no other file was changed. This is a small read-only review task, not a substitute for longer coding, builds, multi-turn workflows, or device testing.

## Work scenarios

`pnpm test:e2e:scenarios` runs six scenarios per provider (Claude, Codex, Grok), each with five concurrent sessions in isolated temporary projects. Each scenario checks its result independently of the agent's own claims (it runs the fixed `inventory.mjs` itself and confirms the test file is unchanged).

| Tag          | What it does                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fix`        | Agents fix a known bug; approvals are granted only for edits to `inventory.mjs`.                                                                                    |
| `run-tests`  | As `fix`, and the agent must also run `node --test inventory.test.mjs` (approved only for that command, optionally with `cd` into its own folder or a `tail` pipe). |
| `multi-turn` | A follow-up turn changes the requirement; both must hold.                                                                                                           |
| `reconnect`  | A second client disconnects and resumes mid-turn; replayed text must match with no duplicates.                                                                      |
| `mixed`      | Five concurrent sessions doing different work (fix, review, run tests, explain).                                                                                    |
| `soak`       | 3 sessions (`BEDDCODE_SOAK_SESSIONS`, 1�5) stay open for 10�30 minutes (`BEDDCODE_SOAK_MINUTES`, default 12), with a prompt at the start, midpoint and end.         |

Run one with, for example: `pnpm exec e2e run --config e2e.scenarios.config.ts --tag claude,run-tests --tag-mode all`. Statistics (timings, host process samples, system and network counters) go to `.e2e/scenario-stats/`.

Status: Claude passes `fix`, `run-tests`, `multi-turn` and `reconnect`; Grok passes all four. Codex was not verified after its usage limit was hit. `mixed` passes for Claude and Grok; `soak` has not been run.

## Desktop app tests

`pnpm test:desktop` launches the real Electron app (`apps/desktop`) with Playwright's Electron support, since TesterArmy has no Electron engine. It uses a temporary `BEDDCODE_HOME`, a temporary Electron user-data folder (so it never touches your installed BeddCode or its single-instance lock), a free port and the fake agent, so no provider quota is used. It builds the web app and the desktop bundle first.

| Test             | What it checks                                                                       |
| ---------------- | ------------------------------------------------------------------------------------ |
| opens a window   | The window loads the app from the app's own host and shows the first-run screen.     |
| desktop bridge   | `window.beddcodeDesktop` is exposed and the sandboxed page has no Node `require`.    |
| host supervision | The app starts its host and reports it running; `/health` answers.                   |
| window buttons   | Maximize, restore and minimize through the bridge.                                   |
| session          | A streamed fake session with an approval, inside the desktop window.                 |
| host killed      | Kill the host process; the app restarts it and the session reappears after a reload. |
| host restart     | `daemon.restart()` replaces the host process.                                        |
| relaunch         | Close the app and open it again; the session is still listed and opens.              |

Statistics go to `.e2e/desktop-stats/`: window and UI-ready time, session time, host recovery and restart time, relaunch time, and app memory (all Electron processes, sampled every 2 seconds).

### Real agents in the desktop app

`pnpm test:desktop:real` runs real agent CLIs inside the desktop app (opt-in; it uses provider quota). The isolated host registers Grok the same way the browser suites do. For each provider it runs two tests:

- a prompt typed into the desktop window gets a `PONG` answer, and
- N sessions run concurrently through the app's host, each reading its own fixture and reporting the unique `BUG-` marker. While they run the window is probed every 500 ms (a `requestAnimationFrame` round trip) so the report shows whether the UI stayed responsive; afterwards the sidebar count must match the sessions the host created (some agents retitle their sessions, so titles are not compared).

Defaults are small so the tests can be checked cheaply: 2 Claude and 3 Grok sessions. Change them with `DESKTOP_CLAUDE_SESSIONS`, `DESKTOP_GROK_SESSIONS` and `DESKTOP_CODEX_SESSIONS`, and choose providers with `DESKTOP_PROVIDERS` (default `claude,grok`; add `codex`). Results (answer time, per-session duration and tool calls, peak overlap, window frame latency, Electron memory and lowest system free RAM) are written to `.e2e/desktop-stats/real-*.json`. The window's frame latency measures the page, not the host or agent processes.

### Desktop session speed

`pnpm test:desktop` also runs `perf.desktop.test.ts`, which times the desktop window with the fake agent so the workload is identical every run. It creates 6 finished sessions, one 10-turn session and 6 sessions held in "running" (the fake agent's `[hold]` prompt keeps a turn working until it is interrupted). Timing happens inside the page: from the click on a sidebar row until that session's own prompt is on screen (`content`), and two animation frames later (`paint`). Each scenario repeats every session three times in a rotating order and reports min, median, p95 and max in milliseconds plus main-thread long tasks (over 50 ms).

| Scenario                | What it measures                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `switchRunning`         | Switching between running sessions                                                           |
| `switchRunningFinished` | Alternating between a running and a finished session                                         |
| `openFinished`          | Opening finished sessions                                                                    |
| `openBigSession`        | Opening the 10-turn session, alternating with another session                                |
| `openComposer`          | Clicking "New session" until the empty composer is shown                                     |
| `coldStart`             | Relaunching the app: time until the sidebar lists the sessions, then opening the big session |

The assertions are loose regression guards (median under 1.5 s, 2 s for the big session). The exact numbers are in `.e2e/desktop-stats/perf-*.json`. Because the fake agent has no model latency, this isolates the app's own rendering and switching.

### Ten-turn session per agent CLI

`pnpm test:desktop:real` also runs `bigsession.real.test.ts`: for each provider, one session with ten user messages and ten agent replies. Later turns depend on earlier ones (a code word given in turn 1, a file read in turn 2, a number computed in turn 4), and turns 3, 4, 5, 8 and 10 must repeat those facts correctly, so the test also shows whether context survives a long session. Per turn it records duration, time to first reply, tool calls and reported input tokens; it also compares the median turn time of the first and second halves. Afterwards it opens the finished session in the window and switches six times between it and a small session, recording open and switch time, long tasks and how many messages are shown. Providers come from `DESKTOP_PROVIDERS` (default `claude,grok`). Results go to `.e2e/desktop-stats/bigsession-*.json`. Token counts are what each provider reports, so they are not comparable between providers.

### Heavy content in the desktop window

`pnpm test:desktop` also runs `heavy.desktop.test.ts` (fake agent, identical every run): a session of 60 turns (120 messages) where every fifth turn carries a 1,500-line command output, two 200-line diffs and a long markdown reply; a sidebar of about 300 sessions (`DESKTOP_BULK_SESSIONS`); and 5 sessions that stream text until interrupted (the fake agent's `[stream]` prompt). It reports open and switch time (`content` and `paint`), animation-frame gaps (`median`, `p95`, `max`, and how many frames took over 50 ms), main-thread long tasks, the DOM size and JS heap of the big session, scroll smoothness through it and through the sidebar, sidebar search time, and cold start with all of it. Results: `.e2e/desktop-stats/heavy-*.json`. The thread loads older messages on request, so the big session is measured both as first shown and after "Show earlier" is clicked until all 120 messages are in the page.

`pnpm test:desktop:real` also runs `heavy.real.test.ts`: for each of Claude, Codex and Grok, five sessions stream a long answer (500+ words, a code block, a table) at once while the window switches between them continuously, then opens the finished sessions. Any frame over 100 ms is reported with the script that caused it. `DESKTOP_PROFILE=1` also saves a CPU profile (`.e2e/desktop-stats/*.cpuprofile`, openable in Chrome DevTools) and lists the hottest functions.

#### Running the real agents on DeepSeek

The heavy real tests run on DeepSeek by default so they do not use the Claude, Codex or Grok allowances. `tests/desktop/deepseek.ts` builds the settings for the desktop app's process only; nothing global is changed:

- Claude uses `ANTHROPIC_BASE_URL`, an API key and the `deepseek-flash[1m]` model id from DeepSeek's documentation, with a throwaway `CLAUDE_CONFIG_DIR` (otherwise Claude Code prefers your signed-in claude.ai token). Effort defaults to `low` to keep timings short (`DEEPSEEK_EFFORT=max` follows DeepSeek's example).
- Codex uses a throwaway `CODEX_HOME` with a `deepseek` provider on the Responses API and an API-key login there, which BeddCode needs to treat Codex as ready.
- Grok uses a throwaway `GROK_HOME` with a custom `[model.deepseek]` entry.

Set `DEEPSEEK_API_KEY` in the shell that runs the tests; the key is read from the environment only and is never written to the repository, a report or a log. `DESKTOP_BACKEND=native` uses the real accounts instead, and `pnpm exec vitest run --config vitest.desktop.real.config.ts backend` checks that all three answer. The throwaway homes are deleted when the run ends.

### Load times over the relay

`pnpm test:relay` measures what a phone or laptop away from home waits for when it reaches the host through the relay, against reaching the host directly. It needs no browser or app build: it starts the Node relay in-process, starts a real host (fake agent) that dials it, and connects real `HostClient`s (the code the apps use) over both routes. `tests/relay/latencyProxy.ts` is a TCP proxy placed on each leg (device to relay, host to relay, device to host when direct); it adds delay, limits bandwidth and counts bytes, so one relay hop costs two legs and a direct connection costs one.

| Profile  | Round trip per leg | Bandwidth per direction |
| -------- | ------------------ | ----------------------- |
| `lan`    | 2 ms               | unlimited               |
| `good`   | 40 ms              | unlimited               |
| `mobile` | 120 ms             | 8 Mbit/s                |
| `poor`   | 300 ms             | 1.5 Mbit/s              |

The host first gets a history to replay: `RELAY_SESSIONS` (default 120) finished sessions plus one long session of `RELAY_HEAVY_TURNS` (default 30) turns with large output, about 4,500 events. For each profile and each route the test records:

| Name          | What it measures                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `pairMs`      | Exchanging a pairing code for a token                                                                          |
| `cold`        | A device that has never seen the host: time until caught up, `connect.ms`, `replay.ms`, events, KB on the wire |
| `request`     | A small request (`projects.list`) one at a time: median and p95                                                |
| `live`        | A streamed answer: time to the first piece, and how late each piece arrives                                    |
| `warm`        | The same device returning with what it holds: time and bytes (nothing but the new part should move)            |
| `reconnectMs` | The link is cut while connected: time until the device is connected again                                      |

`relayVsDirect` gives each as a ratio. `RELAY_PROFILES=mobile,poor` picks profiles. To measure a deployed relay, set `RELAY_URL` (and `RELAY_PASSWORD`): the proxies then shape only the two ends of it, and the relay's own distance and load are real. A local relay measures the protocol, encryption and the relay's forwarding, plus the simulated network. Results: `.e2e/relay-stats/relay-*.json`, including the relay status over time and why each proxied connection closed.

Typical result on this machine (4,500-event history, about 370 KB replayed):

| Profile  | Cold sync direct / relay | Warm sync direct / relay | Small request | Reconnect direct / relay |
| -------- | ------------------------ | ------------------------ | ------------- | ------------------------ |
| `lan`    | 0.33 s / 0.54 s          | 0.12 s / 0.23 s          | 24 / 64 ms    | 0.34 s / 0.42 s          |
| `good`   | 0.50 s / 0.83 s          | 0.20 s / 0.48 s          | 63 / 120 ms   | 0.35 s / 0.61 s          |
| `mobile` | 0.72 s / 1.52 s          | 0.44 s / 0.94 s          | 136 / 264 ms  | 0.54 s / 0.88 s          |
| `poor`   | 1.9 s / 3.6 s            | 1.0 s / 2.2 s            | 315 / 640 ms  | 0.95 s / 1.9 s           |

The relay costs about two times the direct route on every profile, which is what two hops give. Pairing costs four times, because it sets up the encrypted channel first. The relay also adds about 20% to the bytes (encryption and framing). The test found a bug in the Node relay: it closed every connection at its 30-second liveness check, because the check never learned of new sockets. Devices reconnected, so it showed only as a dip every half minute; it is fixed in `packages/relay/src/node.ts`.

#### Data sent over the relay

Each run also counts bytes on every leg, per phase (`pairWire`, `cold.wire`, `requestWire`, `liveWire`, `warm.wire`, `idle16sWire`), as `upKb` (toward the host) and `downKb` (toward the device). Over the relay there are two legs, device to relay (`device`) and host to relay (`host`), which should carry the same payload. Measured on `lan` with the 2,200-event history (about 1.3 MB of events before compression):

| Phase                 | Direct (down)        | Relay, device leg (down) | Relay, host leg (up) |
| --------------------- | -------------------- | ------------------------ | -------------------- |
| First sync            | 166 KB               | 198 KB (+19%)            | 199 KB               |
| 15 small requests     | 0.7 KB up / 0.9 down | 2.0 up / 1.6 down        | 2.0 up / 2.2 down    |
| 3 s of live streaming | 16 KB                | 25 KB (+55%)             | 27 KB                |
| Returning device      | 0.5 KB               | 0.7 KB                   | 0.6 KB               |
| 16 s idle             | ~0                   | 0.1 KB each way          | 0.1 KB each way      |

History is compressed about 8 times on the wire in both routes. The relay's extra comes from encrypting and framing every message, so it costs most on many small messages (streamed text, requests) and least on bulk replay. The host sends each byte to the relay once, and the relay forwards it unchanged, so the two legs match.

#### Changes made after these measurements

- **Fewer round trips per connect.** The client sends `subscribe` right behind `hello` instead of waiting for `welcome`, with the log id so a host with another log replays from the start. Simulated `mobile` / `poor` relay runs: first sync 1.52 s → 1.22 s and 3.6 s → 3.0 s; returning device 0.94 s → 0.70 s and 2.2 s → 1.6 s (direct returning device 0.44 s → 0.30 s).
- **Streamed text through a relay** is joined into pieces every 250 ms instead of 60 ms (a few frames a second, not 19): 56 frames → 18 and 25 KB → 14 KB for 3 s of streaming, at most 250 ms later.
- **Long diffs** in a thread show their first 120 lines and a button for the rest. The fully expanded 120-message thread drops from 26,500 to 16,300 DOM nodes, expanding from 570 ms to 420 ms, and the worst scroll frame from 540 ms to 350 ms. Sidebar rows outside the screen are no longer laid out (sidebar search 68 ms → 33 ms with 306 sessions).
- **History size** (1,001 sessions, 34,000 events, over a simulated `good` relay): the first sync of a new device takes 3.2 s and 790 KB; a returning device 0.3 s. It grows linearly with history and only a device's first connection pays it, so nothing was changed.
