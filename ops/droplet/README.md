# Dev droplet

These scripts set up a personal DigitalOcean droplet (Ubuntu 24.04, `s-4vcpu-8gb-intel`, fra1) that you create when you start working and delete when you stop. You set it up once and save a snapshot. Each session then restores that snapshot and snapshots again at the end. You drive the agents (Claude Code, Codex, Grok) on it through BeddCode over your relay. The host only dials out, so the droplet accepts inbound SSH and nothing else.

| File | Where it runs | What it does |
| --- | --- | --- |
| `config.env.example` | – | Every setting. Copy it to `config.env`. No secrets. |
| `up.sh` | your PC (Git Bash) | Creates the droplet from the newest snapshot, waits for it, and prints how to connect. `--fresh` creates it from plain Ubuntu, for the first time only. |
| `down.sh` | your PC (Git Bash) | Checks for uncommitted work, stops services, shuts down, snapshots, deletes the droplet, and prunes old snapshots. |
| `bootstrap.sh` | droplet, as root, once | Installs everything. Safe to run again. |
| `build-apk.sh` | droplet | Builds a debug or release APK and prints its path, size and an `scp` command. |
| `emu-setup.sh`, `emu-start.sh`, `emu-stop.sh`, `emu-shot.sh` | droplet | Headless Android emulator. It only works if `/dev/kvm` exists. |

## Versions and where they come from

| Tool | Version / command | Source |
| --- | --- | --- |
| JDK | `openjdk-17-jdk-headless` (Ubuntu 24.04 apt) | Expo and React Native both recommend JDK 17; AGP 9.2 needs 17+. |
| Android SDK | platforms 36 + 37, build-tools 36.0.0 + 37.0.0, NDK 27.1.12297006, CMake 3.22.1 | Your installed `react-native@0.88.0/gradle/libs.versions.toml` (compileSdk 37, targetSdk 36, buildTools 37.0.0, NDK 27.1.12297006, AGP 9.2.1). Expo's environment page asks for Platform 36. |
| cmdline-tools | `commandlinetools-linux-15859902_latest.zip`, SHA-256 checked | developer.android.com/studio, "Command line tools only" |
| Node | nvm v0.40.8, Node 22 | github.com/nvm-sh/nvm. React Native needs Node 22.11 or newer; BeddCode needs Node 22 or newer. |
| pnpm | corepack (ships with Node 22), so pnpm 12 is picked up from `packageManager` | – |
| Watchman | not installed | Expo docs: it is only needed for SDK 55 and earlier. |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash`, installs to `~/.local/bin/claude` | code.claude.com/docs/en/setup |
| Codex CLI | `npm install -g @openai/codex` | github.com/openai/codex |
| Grok CLI | `curl -fsSL https://x.ai/cli/install.sh \| bash`, login with `grok login --device-auth` | x.ai/build (Grok Build). The community `grok-cli` projects are not used. |
| gh | apt repo at `cli.github.com/packages` | github.com/cli/cli `docs/install_linux.md` |
| EAS CLI | `npm install -g eas-cli` | Expo docs |
| Maestro | `curl -fsSL https://get.maestro.mobile.dev \| bash` (needs Java 17+) | docs.maestro.dev |
| BeddCode host | `scripts/install-host.sh --own-node --at-boot`. It tries the latest release first, then `--version desktop-dev`, which every manual run of **Actions → Release → Run workflow** rebuilds. If neither has a host bundle, it runs from a source checkout. | This repo's README |
| doctl | `snapshot list --resource droplet`, `droplet create --wait`, `droplet-action shutdown/power-off/snapshot --wait`, `image delete --force`, `balance get` | docs.digitalocean.com doctl reference |

Deprecations to know about:
- Google now marks `sdkmanager` and `emulator` as deprecated in favour of a new `android` CLI. Both still work; the scripts keep using them.
- Maestro documented API 35/36 support as "arriving Q2 2026". If Maestro flows fail on the android-36 image, set `EMULATOR_IMAGE` to an `android-34` image and rerun `emu-setup.sh`.

## First-time setup

1. On your PC, in Git Bash:
   ```bash
   cd ops/droplet && cp config.env.example config.env
   doctl compute ssh-key list          # put your key's ID in SSH_KEY_IDS
   ```
   Then edit `config.env`: set `SSH_KEY_IDS`, `GIT_NAME`, `GIT_EMAIL` and `BEDDCODE_RELAY_URL`.
2. Create the droplet:
   ```bash
   ./up.sh --fresh
   ```
   then run the `ssh root@… bootstrap.sh` command it prints. This takes about 15–25 min. After it finishes, root login is off. Use `ssh dev@<ip>` from then on.
3. As `dev` on the droplet, sign in. You chose to keep these logins in the snapshot:
   ```bash
   gh auth login            # device code
   claude                   # then /login; press c to copy the URL, open it on your PC, paste the code back
   codex login              # follow the URL it prints (or `codex login --device-auth` if your version offers it)
   grok login --device-auth
   beddcode config set relay-password '…'   # type it here; never put it in config.env
   systemctl --user restart beddcode-server && beddcode pair   # pair the desktop app and phone once
   ```
4. Clone your projects into `~/projects` and run `pnpm install` in each. If the latest BeddCode release has no Linux host bundle, bootstrap has already cloned `~/projects/BeddCode` and runs the host from that checkout, through the `~/bin/beddcode` wrapper. Keep that checkout in place, and run `git pull && pnpm install && systemctl --user restart beddcode-server` there to update the host.
5. Run the **test plan** below. Then take the first snapshot with `./down.sh`.

### Secrets: where they live

- No file in this folder contains a key, token or password. Don't put one in `config.env`.
- The agent logins, `gh` token and relay password are stored by those tools in `~/.claude`, `~/.codex`, `~/.grok`, `~/.config/gh` and `~/.beddcode`. **That means they are inside every snapshot.** Treat the snapshots as secrets. If you suspect one leaked, revoke the sessions at each provider and log in again.
- API keys you only need occasionally: `export XAI_API_KEY=…` inside a tmux session, so it is never written to disk. You can also keep them in your password manager.
- Release keystores: never put one on the droplet. Use EAS-managed credentials (`eas credentials`) or sign on your PC.

## Daily workflow

```bash
./up.sh                   # about 2–4 min; BeddCode reconnects through the relay by itself
ssh dev@<ip>              # optional: tmux new -A -s main
# … work through BeddCode …
build-apk.sh ~/projects/BeddCode/apps/mobile     # on the droplet
scp dev@<ip>:apks/<file>.apk .                   # on your PC; or download it from the BeddCode Files pane
./down.sh                 # about 5–15 min, mostly waiting for the snapshot
```

The IP changes every session. `up.sh` prints the new one and clears the stale `known_hosts` entry. The droplet's SSH host key is new each time, so the first connection accepts it automatically. The relay route and device pairings live in `~/.beddcode`, which is in the snapshot, so they don't change when the IP does.

**Gradle settings.** These are in `~/.gradle/gradle.properties` and suit 8 GB of RAM:
- Gradle heap is 3 GB, plus 1 GB metaspace; the Kotlin daemon gets 1.5 GB.
- The daemon stays on, so rebuilds within a session are warm.
- Parallel builds are on, with 2 workers. More workers tend to run out of memory on React Native's C++ steps.
- The build cache is on.

The heap is enough for an Expo app, and ~3 GB stays free for Metro, the host and agents. 6 GB of swap with `vm.swappiness=10` is a safety net, not working memory. If builds get OOM-killed, lower `org.gradle.workers.max` to 1 before you raise the heap.

## Resizing the droplet

The snapshot's minimum disk size is what limits you. You can restore onto the same size or a bigger one, but not onto a smaller disk.
- For a one-off bigger session, set `DROPLET_SIZE=s-8vcpu-16gb` in `config.env` and run `./up.sh`. For 16 GB of RAM you can also raise the Gradle heap to `-Xmx6g` and workers to 4.
- To go back down, the disk size must stay 160 GB. Pick a size with the same disk, such as `s-4vcpu-8gb-intel`, or `s-4vcpu-8gb` if you can do without the emulator. Otherwise you have to bootstrap a fresh droplet.
- `doctl compute size list` shows the slugs and prices.

## Headless Android emulator (agent-driven testing)

`emu-setup.sh` checks `/dev/kvm` **first**. If it is missing, the script prints a message, installs nothing and exits. It does not fall back to a software-only emulator. If the CPU reports `vmx`/`svm` but `/dev/kvm` is missing, the script first loads `kvm_intel` or `kvm_amd`. DigitalOcean doesn't promise nested virtualization, but a test on `s-1vcpu-1gb-intel` in fra1 (2026-11-03) passed: the CPU reported `vmx`, `kvm_intel` loaded, `/dev/kvm` appeared and `nested=Y`. That's why the default size is `s-4vcpu-8gb-intel` ($0.0833/h, the same 160 GB disk as `s-4vcpu-8gb`, so snapshots restore onto either). The non-Intel sizes may land on AMD hosts, where nested KVM isn't offered. Nested performance is lower than bare metal, so expect a slower emulator boot (about 1–3 min). To check by hand: `grep -cE 'vmx|svm' /proc/cpuinfo; ls -l /dev/kvm; cat /sys/module/kvm_intel/parameters/nested`.

If `/dev/kvm` exists, the script installs the `emulator` package and `system-images;android-36;google_apis;x86_64`. It first checks that `sdkmanager --list` offers that image. Then it creates the AVD `pixel36` (Pixel 7 screen, 2048 MB RAM, 4 GB data partition) in `~/.android/avd`, which is inside the snapshot.

**Extra disk:** about 0.4 GB for the emulator package plus 1.5–2 GB for the image, and the AVD grows to about 4 GB as it's used. That's roughly **6 GB** in all, about $0.36/month per kept snapshot. `emu-setup.sh` prints the actual figure.

```bash
emu-start.sh            # headless boot, waits for sys.boot_completed, prints status
emu-shot.sh [name]      # prints ~/shots/<name>-YYYYMMDD-HHMMSS.png
emu-stop.sh
```

Commands for agents (with only one device running, `adb` targets it; otherwise add `-s emulator-5554`):

```bash
adb install -r ~/apks/app-debug.apk                       # install or replace
adb shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1   # launch by package
adb shell am start -n com.example.app/.MainActivity       # launch an activity
adb shell input tap 540 1200                              # tap x y (pixels)
adb shell input text 'hello%sworld'                       # type (%s = space)
adb shell input keyevent 66                               # Enter (4 = Back, 3 = Home)
adb shell input swipe 540 1800 540 600 300                # swipe x1 y1 x2 y2 ms
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml ~/shots/ui.xml   # view tree with bounds
adb logcat -d -t 200 '*:E'                                # recent errors
adb shell pm clear com.example.app                        # reset app data
```

To tap an element: read its `bounds="[x1,y1][x2,y2]"` from `ui.xml` and tap the centre. Maestro is installed (`maestro test flow.yaml`) and uses the same device.

## "Did I delete the droplet?" checklist

A forgotten droplet bills until the monthly cap for its size, even when it is powered off.

- [ ] `./down.sh` ended with "Deleted devbox."
- [ ] `doctl compute droplet list` doesn't list `devbox`.
- [ ] `doctl compute snapshot list devbox-* --resource droplet` shows at most 2 snapshots, and the newest has today's date.
- [ ] No leftover volumes or reserved IPs: `doctl compute volume list`, `doctl compute reserved-ip list` (the scripts create neither).
- [ ] `doctl balance get` shows month-to-date usage that looks right.
- [ ] Optional: in the DO dashboard, Billing → Billing alerts, set an email alert, for example at your `BILLING_WARN_USD`.

## Test plan (before the first snapshot)

Run these as `dev` on the freshly bootstrapped droplet.

1. **CLIs launch:**
   ```bash
   claude --version && codex --version && grok --version && gh --version && eas --version \
     && maestro --version && node -v && pnpm -v && java -version && sdkmanager --list_installed | head
   beddcode doctor && systemctl --user is-active beddcode-server
   free -h && swapon --show && sudo ufw status && cat ~/.gradle/gradle.properties
   ```
   Then open a session for each agent from the BeddCode desktop app and confirm that each one replies.
2. **A sample Expo app builds a debug APK:**
   ```bash
   cd ~/projects && npx create-expo-app@latest apk-smoke --yes && cd apk-smoke
   time build-apk.sh .          # first build: expect roughly 10–20 min
   time build-apk.sh .          # immediate rebuild: should be well under 2 min
   ```
   Install the APK on your phone and check that it opens. Then run `build-apk.sh ~/projects/BeddCode/apps/mobile` for your real app.
3. **A rebuild after a restore is fast (the Gradle cache survived):**
   - Note the size: `du -sh ~/.gradle/caches ~/Android/Sdk`.
   - Run `./down.sh` (snapshot plus delete), then `./up.sh`.
   - On the restored droplet, check that `du -sh ~/.gradle/caches` matches, then run `time build-apk.sh ~/projects/apk-smoke`. Expect 1–3 min (a cold daemon, but no downloads). Before you run `build-apk.sh`, `ls ~/projects/apk-smoke/android/app/build/outputs/apk/debug` should still show the old APK.
   - If it takes 10+ min again, the cache went missing. Check for `GRADLE_USER_HOME` overrides and that `~/.gradle` belongs to `dev`.
4. **Emulator** (only if `/dev/kvm` exists): run `emu-start.sh`, `adb install` the smoke APK, launch it, then run `emu-shot.sh`. Open the PNG from the BeddCode Files pane.
