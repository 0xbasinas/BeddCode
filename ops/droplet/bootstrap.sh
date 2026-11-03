#!/usr/bin/env bash
# bootstrap.sh - one-time setup of the dev droplet. Runs ON the droplet as root, from this folder:
#
#   scp -r ops/droplet root@<ip>:/root/devbox && ssh root@<ip> 'bash /root/devbox/bootstrap.sh'
#
# Idempotent: every step checks before it changes anything, so running it again is safe (later
# runs as the dev user: `sudo bash ~/devbox/bootstrap.sh`). It reads ./config.env and:
#   - creates the dev user (key from root's authorized_keys, passwordless sudo), hardens sshd
#   - ufw (inbound SSH only; the BeddCode host dials out to the relay), unattended security updates
#   - swap + vm.swappiness, base packages, tmux config, git identity
#   - nvm + Node, pnpm via corepack, eas-cli, gh, Claude Code, Codex CLI, Grok CLI, Maestro
#   - JDK 17, Android SDK (cmdline-tools, platforms, build-tools, NDK), ~/.gradle/gradle.properties
#   - the BeddCode host as a systemd user service pointed at your relay
#   - copies build-apk.sh and emu-*.sh to ~dev/bin and runs emu-setup.sh (it stops itself without /dev/kvm)
# Everything lives under /home/dev, so the SDK and Gradle cache are kept in the snapshot.
# It never writes secrets; logins happen afterwards by hand (README "First-time setup").
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (or with sudo)"
[ -f "$HERE/config.env" ] || die "missing $HERE/config.env (copy config.env.example and edit it)"
# shellcheck source=/dev/null
. "$HERE/config.env"
grep -q 'VERSION_ID="24.04"' /etc/os-release || die "expected Ubuntu 24.04"

U="$DEV_USER"
H="/home/$U"
ANDROID_HOME="$H/Android/Sdk"
export DEBIAN_FRONTEND=noninteractive

# Run a login shell as the dev user, with its systemd user bus available.
as_dev() {
  local uid; uid="$(id -u "$U")"
  sudo -iu "$U" env XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" bash -lc "$1"
}

# ---------------------------------------------------------------------------
log "Dev user '$U'"
if ! id "$U" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$U"
fi
usermod -aG sudo "$U"
echo "$U ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$U"
chmod 440 "/etc/sudoers.d/90-$U"
install -d -m 700 -o "$U" -g "$U" "$H/.ssh"
if [ -s /root/.ssh/authorized_keys ]; then
  touch "$H/.ssh/authorized_keys"
  while read -r key; do
    [ -n "$key" ] && ! grep -qxF "$key" "$H/.ssh/authorized_keys" && echo "$key" >> "$H/.ssh/authorized_keys"
  done < /root/.ssh/authorized_keys
fi
[ -s "$H/.ssh/authorized_keys" ] || die "no SSH key for $U; refusing to lock down sshd"
chown "$U:$U" "$H/.ssh/authorized_keys"; chmod 600 "$H/.ssh/authorized_keys"
install -d -o "$U" -g "$U" "$H/bin" "$H/projects" "$H/apks" "$H/shots" "$H/devbox"
cp -f "$HERE"/*.sh "$HERE"/config.env "$HERE"/README.md "$H/devbox/" 2>/dev/null || true
for f in build-apk.sh emu-setup.sh emu-start.sh emu-stop.sh emu-shot.sh; do
  install -m 755 -o "$U" -g "$U" "$HERE/$f" "$H/bin/$f"
done
chown -R "$U:$U" "$H/devbox"

log "sshd: keys only, no root login"
cat > /etc/ssh/sshd_config.d/10-devbox.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t && systemctl reload ssh

log "Firewall (ufw): deny inbound except SSH"
apt-get update -q
apt-get install -y -q ufw
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ufw status verbose | head -n 5

log "Unattended security updates (no automatic reboot)"
apt-get install -y -q unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52devbox-no-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
EOF

log "Swap ${SWAP_SIZE_GB}G, vm.swappiness=$SWAPPINESS"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  [ -f /swapfile ] || fallocate -l "${SWAP_SIZE_GB}G" /swapfile
  chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo "vm.swappiness=$SWAPPINESS" > /etc/sysctl.d/90-devbox.conf
sysctl -q --system

log "Base packages and JDK 17"
apt-get install -y -q git curl wget unzip zip tar ca-certificates build-essential \
  python3 python3-venv python3-pip tmux ripgrep fd-find fzf jq htop openjdk-17-jdk-headless
ln -sf "$(command -v fdfind)" /usr/local/bin/fd

log "GitHub CLI (apt repo from cli.github.com)"
if ! command -v gh >/dev/null; then
  install -d -m 755 /etc/apt/keyrings
  out="$(mktemp)"
  wget -nv -O "$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg
  install -m 644 "$out" /etc/apt/keyrings/githubcli-archive-keyring.gpg; rm -f "$out"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -q && apt-get install -y -q gh
fi

log "Shell environment for $U (ANDROID_HOME, PATH, JAVA_HOME)"
cat > "$H/.devbox-env" <<EOF
# Written by bootstrap.sh - sourced from ~/.bashrc and ~/.profile.
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME="$ANDROID_HOME"
export PATH="\$HOME/bin:\$HOME/.local/bin:\$HOME/.maestro/bin:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:\$PATH"
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
EOF
chown "$U:$U" "$H/.devbox-env"
for rc in .bashrc .profile; do
  touch "$H/$rc"; chown "$U:$U" "$H/$rc"
  grep -q 'devbox-env' "$H/$rc" || echo '[ -f "$HOME/.devbox-env" ] && . "$HOME/.devbox-env"' >> "$H/$rc"
done

log "tmux config"
cat > "$H/.tmux.conf" <<'EOF'
# Written by bootstrap.sh
set -g prefix C-a
unbind C-b
bind C-a send-prefix
set -g mouse on
set -g history-limit 50000
set -g base-index 1
set -g default-terminal "tmux-256color"
set -sg escape-time 10
EOF
chown "$U:$U" "$H/.tmux.conf"

log "Git identity"
as_dev "git config --global user.name '$GIT_NAME' && git config --global user.email '$GIT_EMAIL' && git config --global init.defaultBranch main"

log "systemd user session for $U (linger)"
loginctl enable-linger "$U"
systemctl start "user@$(id -u "$U").service"

log "nvm $NVM_VERSION, Node $NODE_VERSION, pnpm (corepack), eas-cli, Codex CLI"
as_dev "[ -s ~/.nvm/nvm.sh ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash"
as_dev ". ~/.nvm/nvm.sh && nvm install $NODE_VERSION && nvm alias default $NODE_VERSION && corepack enable \
  && npm install -g eas-cli @openai/codex && node -v"

log "PATH for systemd user services (the BeddCode host launches the agents)"
node_bin="$(as_dev '. ~/.nvm/nvm.sh >/dev/null && dirname "$(nvm which default)"')"
install -d -o "$U" -g "$U" "$H/.config/environment.d"
cat > "$H/.config/environment.d/10-devbox.conf" <<EOF
# Written by bootstrap.sh - environment for systemd --user services such as beddcode-server.
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ANDROID_HOME=$ANDROID_HOME
PATH=$H/bin:$H/.local/bin:$H/.maestro/bin:$node_bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
chown -R "$U:$U" "$H/.config"
systemctl restart "user@$(id -u "$U").service"   # re-reads environment.d

log "Claude Code (native installer)"
as_dev "command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash"
log "Grok CLI (xAI installer)"
as_dev "command -v grok >/dev/null || curl -fsSL https://x.ai/cli/install.sh | bash"
if [ "${INSTALL_MAESTRO:-0}" = 1 ]; then
  log "Maestro"
  as_dev "[ -x ~/.maestro/bin/maestro ] || curl -fsSL https://get.maestro.mobile.dev | bash"
fi

log "Android SDK in $ANDROID_HOME"
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/tools.zip" "https://dl.google.com/android/repository/$ANDROID_CMDLINE_TOOLS_ZIP"
  echo "$ANDROID_CMDLINE_TOOLS_SHA256  $tmp/tools.zip" | sha256sum -c - || die "cmdline-tools checksum mismatch"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  install -d -o "$U" -g "$U" "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
  chown -R "$U:$U" "$H/Android"
fi
as_dev "yes | sdkmanager --licenses >/dev/null 2>&1" || true
# Google sometimes names a package differently (e.g. platforms;android-37.0), so match each
# wanted package against what sdkmanager actually offers instead of failing the whole install.
avail="$(as_dev 'sdkmanager --list 2>/dev/null' \
  | awk -F'|' 'NF >= 3 { gsub(/ /, "", $1); if ($1 != "" && $1 != "Path" && $1 !~ /^-+$/) print $1 }' | sort -u)"
pkgs=()
for p in $ANDROID_PACKAGES; do
  if grep -qxF "$p" <<< "$avail"; then
    pkgs+=("$p")
  else
    # Closest offered name; a stable one wins over -beta/-rc/-preview/-alpha.
    cands="$(grep -E "^${p//./\\.}([.;-]|$)" <<< "$avail" || true)"
    alt="$(grep -viE -- '-(alpha|beta|rc|preview)' <<< "$cands" | sort -V | tail -1 || true)"
    [ -n "$alt" ] || alt="$(sort -V <<< "$cands" | tail -1 || true)"
    if [ -n "$alt" ]; then
      echo "  $p is not offered; using $alt"; pkgs+=("$alt")
    else
      echo "  WARNING: $p is not offered by sdkmanager; skipped (Gradle downloads what a project needs)"
    fi
  fi
done
[ "${#pkgs[@]}" -gt 0 ] || die "sdkmanager offered none of: $ANDROID_PACKAGES"
as_dev "sdkmanager --install $(printf '"%s" ' "${pkgs[@]}") && sdkmanager --list_installed"

log "Gradle settings for 8 GB RAM (~/.gradle/gradle.properties)"
install -d -o "$U" -g "$U" "$H/.gradle"
cat > "$H/.gradle/gradle.properties" <<'EOF'
# Written by bootstrap.sh. User-home settings override a project's own gradle.properties.
# 3 GB heap + 1 GB metaspace for Gradle, 1.5 GB for the Kotlin daemon: leaves ~3 GB for
# Metro, the BeddCode host and the agents; swap catches spikes.
org.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
kotlin.daemon.jvmargs=-Xmx1536m
# Daemon stays warm between builds in a session (fast rebuilds); it is killed by down.sh.
org.gradle.daemon=true
org.gradle.parallel=true
# 2 workers: React Native's C++ modules OOM easily with more on 8 GB.
org.gradle.workers.max=2
# Build cache lives in ~/.gradle/caches, which is inside the snapshot.
org.gradle.caching=true
EOF
chown "$U:$U" "$H/.gradle/gradle.properties"

log "BeddCode host (systemd user service, relay: $BEDDCODE_RELAY_URL)"
# Prefer a release bundle: the latest release, else the desktop-dev prerelease (rebuilt by every
# manual Release run). With neither, run the host from a source checkout (public repo, no login
# needed) through a `beddcode` wrapper in ~/bin.
installer="curl -fsSL https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.sh | sh -s -- --own-node --at-boot"
if [ -d "$H/projects/BeddCode/.git" ] && [ -x "$H/bin/beddcode" ]; then
  echo "  Host already runs from the source checkout; update it there (README step 4)"
elif as_dev "$installer" || { echo "  Trying the desktop-dev prerelease"; as_dev "$installer --version desktop-dev"; }; then
  :
else
  echo "  No release host bundle; installing the host from source in ~/projects/BeddCode"
  as_dev "[ -d ~/projects/BeddCode/.git ] || git clone https://github.com/0xbasinas/BeddCode.git ~/projects/BeddCode"
  as_dev "cd ~/projects/BeddCode && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile"
  cat > "$H/bin/beddcode" <<'EOF'
#!/usr/bin/env bash
# Written by bootstrap.sh: runs the BeddCode host CLI from the source checkout. It cd's into the
# repo so corepack uses the pinned pnpm (packageManager) instead of prompting to download another.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$HOME/projects/BeddCode" || { echo "missing ~/projects/BeddCode" >&2; exit 1; }
exec pnpm --silent --filter @beddcode/server start "$@" < /dev/null
EOF
  chown "$U:$U" "$H/bin/beddcode"; chmod 755 "$H/bin/beddcode"
  as_dev "beddcode install-service --at-boot"
fi
as_dev "beddcode config set relay-url '$BEDDCODE_RELAY_URL' && systemctl --user restart beddcode-server.service \
  && sleep 3 && systemctl --user --no-pager status beddcode-server.service | head -n 5"

if [ "${INSTALL_EMULATOR:-0}" = 1 ]; then
  log "Headless Android emulator (emu-setup.sh)"
  as_dev "emu-setup.sh" || echo "emu-setup.sh did not finish; see its message above (rest of bootstrap is done)."
fi

log "Done"
cat <<EOF
Next (as $U, see README "First-time setup"):
  ssh $U@<ip>        then: gh auth login, claude, codex login, grok login --device-auth,
                     beddcode config set relay-password ..., beddcode pair
Disk used: $(df -h --output=used / | tail -1 | tr -d ' ') on /
EOF
