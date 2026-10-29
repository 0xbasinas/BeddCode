#!/bin/sh
# Installs the BeddCode host on a Linux machine with no desktop, and runs it in the background:
#
#   curl -fsSL https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.sh | sh
#
# It needs curl and tar. It uses the Node.js 22+ already on the machine; without one it downloads
# the official Node 22 into its own folder (nothing is installed system-wide). Options (after `sh -s --` when piped):
#   --version <tag>   install that release (default: the latest)
#   --no-service      unpack only; do not start it in the background
#   --own-node        use a private Node 22 even when the machine has one
#   --port <n>        the port the background host listens on (default 3773, the desktop app's)
#   --at-boot         keep it running without a login session (enables lingering; may ask for sudo)
#   --uninstall       stop and remove the background host, the command and the install folder
#                     (your sessions and settings in ~/.beddcode are kept)
# Run it again to update (the background host is restarted on the new version).
# Variables: BEDDCODE_PREFIX (where it unpacks, default ~/.local/share/beddcode-host),
#            BEDDCODE_BIN (where the command goes, default ~/.local/bin).
set -eu

REPO="0xbasinas/BeddCode"
ASSET="beddcode-host-linux-x64.tar.gz"
PREFIX="${BEDDCODE_PREFIX:-$HOME/.local/share/beddcode-host}"
BIN="${BEDDCODE_BIN:-$HOME/.local/bin}"
VERSION="latest"
SERVICE=1
OWN_NODE=0
PORT=3773
AT_BOOT=0
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag}"; shift ;;
    --no-service) SERVICE=0 ;;
    --own-node) OWN_NODE=1 ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --at-boot) AT_BOOT=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux; on Windows use scripts/install-host.ps1, on macOS the desktop app"
case "$PORT" in ''|*[!0-9]*) die "--port needs a number (not $PORT)" ;; esac

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -x "$PREFIX/beddcode" ]; then
    "$PREFIX/beddcode" host uninstall || true
  fi
  rm -rf "$PREFIX" "$PREFIX.old"
  # Only the link this installer made; a beddcode command from the desktop app is left alone.
  if [ -L "$BIN/beddcode" ] && [ "$(readlink "$BIN/beddcode")" = "$PREFIX/beddcode" ]; then
    rm -f "$BIN/beddcode"
  fi
  echo "Removed the BeddCode host from $PREFIX. Your sessions and settings in ~/.beddcode are kept."
  exit 0
fi

case "$(uname -m)" in x86_64|amd64) ;; *) die "only x64 is built so far (this is $(uname -m))" ;; esac
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

need_node=1
if [ "$OWN_NODE" -eq 0 ] && command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 22 ] && need_node=0
fi

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL "$url" -o "$tmp/$ASSET" || die "download failed; is there a release with $ASSET?"
# Releases carry the archive's SHA-256 next to it (older ones do not; then it is not verified).
if curl -fsSL "$url.sha256" -o "$tmp/$ASSET.sha256" 2>/dev/null; then
  (cd "$tmp" && sha256sum -c "$ASSET.sha256" >/dev/null 2>&1) || die "$ASSET did not match its checksum"
else
  echo "warning: this release has no checksum for $ASSET; it was not verified" >&2
fi

mkdir -p "$tmp/unpacked"
tar -xzf "$tmp/$ASSET" -C "$tmp/unpacked"
[ -f "$tmp/unpacked/server/main.mjs" ] || die "the download is not a BeddCode host"

# Without a usable Node, fetch the official Node 22 into the host's own folder. The launcher prefers
# it, and the background service runs with it. The download is checked against nodejs.org's hashes.
if [ "$need_node" -eq 1 ]; then
  base="https://nodejs.org/dist/latest-v22.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "could not reach nodejs.org"
  line=$(grep -E ' node-v22\.[0-9.]+-linux-x64\.tar\.xz$' "$tmp/SHASUMS256.txt" | head -n1)
  [ -n "$line" ] || die "no Node 22 build found for linux-x64"
  file=${line##* }
  echo "Downloading Node.js ($file)"
  curl -fsSL "$base/$file" -o "$tmp/$file" || die "Node download failed"
  (cd "$tmp" && echo "$line" | sha256sum -c - >/dev/null) || die "Node download did not match its checksum"
  mkdir -p "$tmp/unpacked/node"
  tar -xJf "$tmp/$file" -C "$tmp/unpacked/node" --strip-components=1 || die "could not unpack Node (is xz installed?)"
fi

# A host already answering on the port (the desktop app's own, say) keeps the background one from
# starting until it stops; say so rather than leave it failing quietly.
was_active=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user -q is-active beddcode-server.service 2>/dev/null; then
  was_active=1
fi
other=""
if [ "$SERVICE" -eq 1 ] && [ "$was_active" -eq 0 ] && curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  other=1
  {
    echo "warning: a BeddCode host already answers on port $PORT (the desktop app's own?). The background host" >&2
    echo "warning: starts once it stops. In its Automatic host setting the desktop app uses the background host" >&2
    echo "warning: instead of starting its own: quit it and open it again. Or install on another port with --port." >&2
  }
fi

# Swap the new copy in only once it is complete, so a failed update leaves the old one working.
mkdir -p "$(dirname "$PREFIX")" "$BIN"
rm -rf "$PREFIX.old"
[ -d "$PREFIX" ] && mv "$PREFIX" "$PREFIX.old"
mv "$tmp/unpacked" "$PREFIX"
rm -rf "$PREFIX.old"
ln -sf "$PREFIX/beddcode" "$BIN/beddcode"
chmod +x "$PREFIX/beddcode"
echo "Installed to $PREFIX"

case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH to use the beddcode command." ;; esac

port_args=""
[ "$PORT" = 3773 ] || port_args="--port $PORT"
if [ "$SERVICE" -eq 1 ]; then
  boot_args=""
  [ "$AT_BOOT" -eq 1 ] && boot_args="--at-boot"
  # shellcheck disable=SC2086 # the optional flags are meant to split
  "$PREFIX/beddcode" host install $port_args $boot_args
  # It was already running the old version (enabling a running service does not restart it).
  [ "$was_active" -eq 1 ] && systemctl --user restart beddcode-server.service
  if [ -z "$other" ]; then
    i=0
    while [ "$i" -lt 20 ] && ! curl -fsS -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
      sleep 0.5; i=$((i + 1))
    done
  fi
  echo
  # shellcheck disable=SC2086
  "$PREFIX/beddcode" host status $port_args || true
  echo
  [ "$AT_BOOT" -eq 1 ] || echo "To keep it running after you log out, run this again with --at-boot (or: sudo loginctl enable-linger \"$USER\")"
  echo "Pair your phone or another computer with:  beddcode pair"
  echo "Check everything with:  beddcode doctor   (it also lists the agent CLIs you still need)"
  echo "Update by running this installer again; remove everything with --uninstall."
elif [ "$was_active" -eq 1 ]; then
  # An update of a host already running in the background: restart it on the new version.
  systemctl --user restart beddcode-server.service && echo "Restarted the background host."
fi
