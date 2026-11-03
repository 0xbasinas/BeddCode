#!/usr/bin/env bash
# build-apk.sh - builds an Android APK from an Expo / React Native project ON the droplet,
# copies it to ~/apks with a timestamp, and prints its path, size and an scp command for your PC.
#
#   build-apk.sh [project-dir] [--release]      (default: current dir, debug build)
#
# An Expo project without an android/ folder is prebuilt first (`npx expo prebuild`).
# --release builds assembleRelease. Without your own signing config, the React Native template
# signs it with the debug key: fine for your phone, not for the Play Store. Never keep a
# release keystore on the droplet (it ends up in the snapshot); use EAS credentials instead.
#
# Time: the first build after bootstrap takes roughly 10-20 min on 4 vCPU (Gradle distribution,
# Maven dependencies, NDK/C++ compiles). A rebuild with a warm cache takes about 1-3 min, also
# right after restoring from the snapshot (only the Gradle daemon start is lost).
set -euo pipefail

log() { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

dir="."; variant="debug"
for arg in "$@"; do
  case "$arg" in
    --release) variant="release" ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) dir="$arg" ;;
  esac
done
cd "$dir" || die "no such directory: $dir"
[ -f package.json ] || die "$(pwd) has no package.json (pass the app folder, e.g. apps/mobile)"
[ -n "${ANDROID_HOME:-}" ] || die "ANDROID_HOME is not set (log in again, or source ~/.devbox-env)"

if [ ! -d android ]; then
  log "No android/ folder: running expo prebuild"
  npx expo prebuild --platform android --no-install
fi

task="assemble$(tr '[:lower:]' '[:upper:]' <<< "${variant:0:1}")${variant:1}"
log "Gradle $task in $(pwd)/android"
start=$(date +%s)
(cd android && ./gradlew "$task")
secs=$(( $(date +%s) - start ))

apk="$(ls -t android/app/build/outputs/apk/"$variant"/*.apk 2>/dev/null | head -1)"
[ -n "$apk" ] || die "build finished but no APK found under android/app/build/outputs/apk/$variant"

mkdir -p "$HOME/apks"
name="$(basename "$(pwd)")-$(date +%Y%m%d-%H%M)-$variant.apk"
cp "$apk" "$HOME/apks/$name"
ip="$(curl -fs --max-time 2 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || echo '<droplet-ip>')"

log "Built in $((secs / 60))m $((secs % 60))s"
echo "APK:  $HOME/apks/$name"
echo "Size: $(du -h "$HOME/apks/$name" | cut -f1)"
echo "Copy to your PC (Git Bash):  scp $USER@$ip:apks/$name ."
echo "Or download it from the BeddCode Files pane (~/apks)."
