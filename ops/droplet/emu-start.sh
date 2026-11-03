#!/usr/bin/env bash
# emu-start.sh - starts the AVD headless (no window, no audio, software GPU), waits until Android
# has finished booting, and prints its status. Log: ~/.android/emu.log. Stop with emu-stop.sh.
set -euo pipefail

# shellcheck source=/dev/null
[ -f "$HOME/devbox/config.env" ] && . "$HOME/devbox/config.env"
AVD_NAME="${AVD_NAME:-pixel36}"
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -e /dev/kvm ] || die "/dev/kvm is missing; this droplet cannot run the emulator"
if adb devices | grep -q '^emulator-'; then
  echo "An emulator is already running:"; adb devices; exit 0
fi

echo "Starting $AVD_NAME (headless)..."
nohup emulator -avd "$AVD_NAME" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
  -no-snapshot-save -accel on > "$HOME/.android/emu.log" 2>&1 &
pid=$!

adb wait-for-device
for i in $(seq 1 120); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  kill -0 "$pid" 2>/dev/null || die "emulator exited; see ~/.android/emu.log"
  [ "$i" = 120 ] && die "not booted after 6 minutes; see ~/.android/emu.log"
  sleep 3
done
adb shell input keyevent 82 >/dev/null 2>&1 || true   # dismiss the lock screen

echo "Booted. pid $pid"
adb devices
echo "Android $(adb shell getprop ro.build.version.release | tr -d '\r'), API $(adb shell getprop ro.build.version.sdk | tr -d '\r'), screen $(adb shell wm size | awk '{print $3}' | tr -d '\r')"
