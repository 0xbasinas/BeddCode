#!/usr/bin/env bash
# emu-stop.sh - stops every running emulator cleanly (adb emu kill), then waits for it to exit.
set -euo pipefail

serials="$(adb devices | awk '/^emulator-/ {print $1}')"
[ -n "$serials" ] || { echo "No emulator running."; exit 0; }
for s in $serials; do
  echo "Stopping $s"
  adb -s "$s" emu kill >/dev/null 2>&1 || true
done
for _ in $(seq 1 20); do
  pgrep -u "$USER" -f 'qemu-system|emulator -avd' >/dev/null || { echo "Stopped."; exit 0; }
  sleep 1
done
echo "Still running after 20s; forcing it."
pkill -u "$USER" -f 'qemu-system' || true
