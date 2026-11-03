#!/usr/bin/env bash
# emu-setup.sh - installs a headless Android emulator for agent-driven testing. Runs ON the droplet
# as the dev user (bootstrap.sh calls it; safe to re-run). Reads ~/devbox/config.env.
#
# It STOPS FIRST if /dev/kvm is missing: without hardware acceleration the emulator is too slow to
# be useful, and no software-only emulator is installed instead. DigitalOcean does not officially
# support nested virtualization, so expect this to stop on a regular droplet.
#
# Otherwise it installs the emulator package and $EMULATOR_IMAGE with sdkmanager, and creates the
# AVD $AVD_NAME (Pixel screen, 2048 MB RAM) under ~/.android/avd, which is inside the snapshot.
set -euo pipefail

log() { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
# shellcheck source=/dev/null
[ -f "$HOME/devbox/config.env" ] && . "$HOME/devbox/config.env"
EMULATOR_IMAGE="${EMULATOR_IMAGE:-system-images;android-36;google_apis;x86_64}"
AVD_NAME="${AVD_NAME:-pixel36}"

# The CPU may offer virtualization while the kvm module is simply not loaded yet.
if [ ! -e /dev/kvm ] && grep -qE '\b(vmx|svm)\b' /proc/cpuinfo; then
  log "CPU has vmx/svm; loading the kvm module"
  sudo modprobe kvm_intel 2>/dev/null || sudo modprobe kvm_amd 2>/dev/null || true
  grep -qxF kvm_intel /etc/modules-load.d/kvm.conf 2>/dev/null || {
    lsmod | grep -q '^kvm_intel' && echo kvm_intel | sudo tee /etc/modules-load.d/kvm.conf >/dev/null
    lsmod | grep -q '^kvm_amd' && echo kvm_amd | sudo tee /etc/modules-load.d/kvm.conf >/dev/null
  } || true
fi
if [ ! -e /dev/kvm ]; then
  cat >&2 <<'EOF'
/dev/kvm is missing: this droplet has no hardware virtualization, so the emulator part is SKIPPED.
Nothing was installed. Keep testing on your phone (build-apk.sh). To check again on another size
or region: ls -l /dev/kvm; cat /sys/module/kvm_intel/parameters/nested
EOF
  exit 2
fi
[ -r /dev/kvm ] && [ -w /dev/kvm ] || {
  log "Adding $USER to the kvm group"
  sudo usermod -aG kvm "$USER"
  echo "Log out and back in (or reboot), then run emu-setup.sh again."; exit 1
}
command -v sdkmanager >/dev/null || die "sdkmanager not on PATH; run bootstrap.sh first"

# Even headless (-no-window), the emulator's graphics stack loads X11/xcb and a few desktop
# libraries; Ubuntu Server has none of them, and without libX11-xcb it segfaults at start.
log "Libraries the emulator loads (no desktop is installed)"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q libx11-6 libx11-xcb1 libxcb1 libxext6 \
  libxrender1 libxrandr2 libxfixes3 libxdamage1 libxcomposite1 libxcursor1 libxi6 libxtst6 \
  libxkbfile1 libxkbcommon0 libxkbcommon-x11-0 libnss3 libpulse0 libgbm1 libdrm2 libgl1 libegl1 \
  libdbus-1-3 libasound2t64 >/dev/null

log "Checking that $EMULATOR_IMAGE is offered by sdkmanager"
sdkmanager --list 2>/dev/null | grep -qF "$EMULATOR_IMAGE" \
  || die "$EMULATOR_IMAGE is not in 'sdkmanager --list'; pick a current one: sdkmanager --list | grep 'system-images;android-3'"

before="$(du -sm "$ANDROID_HOME" "$HOME/.android" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
log "Installing emulator and $EMULATOR_IMAGE"
yes | sdkmanager --licenses >/dev/null || true
sdkmanager --install "emulator" "$EMULATOR_IMAGE"

if avdmanager list avd -c | grep -qx "$AVD_NAME"; then
  log "AVD $AVD_NAME already exists"
else
  log "Creating AVD $AVD_NAME"
  echo no | avdmanager create avd -n "$AVD_NAME" -k "$EMULATOR_IMAGE" -d pixel_7
fi
cfg="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
set_cfg() { grep -q "^$1=" "$cfg" && sed -i "s|^$1=.*|$1=$2|" "$cfg" || echo "$1=$2" >> "$cfg"; }
# Software rendering under nested KVM is slow: 4 cores and a 720x1600 screen (about half the
# pixels of a Pixel 7) keep System UI from stopping responding; 3 GB as API 36 asks for more than 2.
set_cfg hw.ramSize 3072
set_cfg hw.cpu.ncore 4
set_cfg hw.lcd.width 720
set_cfg hw.lcd.height 1600
set_cfg hw.lcd.density 320
set_cfg disk.dataPartition.size 4G
set_cfg hw.keyboard yes
set_cfg hw.audioInput no

after="$(du -sm "$ANDROID_HOME" "$HOME/.android" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
log "Done. Emulator + image + AVD use about $(( (after - before) )) MB now (the AVD grows to ~4 GB with use)."
echo "Start it with: emu-start.sh"
