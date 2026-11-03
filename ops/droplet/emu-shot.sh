#!/usr/bin/env bash
# emu-shot.sh - saves a PNG screenshot of the running emulator (or the only adb device) to
# ~/shots/shot-YYYYMMDD-HHMMSS.png and prints the path. Optional: emu-shot.sh <name>
set -euo pipefail

mkdir -p "$HOME/shots"
out="$HOME/shots/${1:-shot}-$(date +%Y%m%d-%H%M%S).png"
adb get-state >/dev/null 2>&1 || { echo "No device; start one with emu-start.sh" >&2; exit 1; }
adb exec-out screencap -p > "$out"
[ -s "$out" ] || { rm -f "$out"; echo "Screenshot was empty" >&2; exit 1; }
echo "$out"
