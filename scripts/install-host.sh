#!/bin/sh
# Installs the BeddCode host on a Linux machine with no desktop, and runs it in the background:
#
#   curl -fsSL https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.sh | sh
#
# It needs Node.js 22 or newer and curl. Options (after `sh -s --` when piped):
#   --version <tag>   install that release (default: the latest)
#   --no-service      unpack only; do not start it in the background
# Variables: BEDDCODE_PREFIX (where it unpacks, default ~/.local/share/beddcode-host),
#            BEDDCODE_BIN (where the command goes, default ~/.local/bin).
set -eu

REPO="0xbasinas/BeddCode"
ASSET="beddcode-host-linux-x64.tar.gz"
PREFIX="${BEDDCODE_PREFIX:-$HOME/.local/share/beddcode-host}"
BIN="${BEDDCODE_BIN:-$HOME/.local/bin}"
VERSION="latest"
SERVICE=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag}"; shift ;;
    --no-service) SERVICE=0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux; on Windows or macOS use the desktop app"
case "$(uname -m)" in x86_64|amd64) ;; *) die "only x64 is built so far (this is $(uname -m))" ;; esac
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required (https://nodejs.org)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL "$url" -o "$tmp/$ASSET" || die "download failed; is there a release with $ASSET?"

mkdir -p "$tmp/unpacked"
tar -xzf "$tmp/$ASSET" -C "$tmp/unpacked"
[ -f "$tmp/unpacked/server/main.mjs" ] || die "the download is not a BeddCode host"

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

if [ "$SERVICE" -eq 1 ]; then
  "$BIN/beddcode" host install
  echo
  echo "To keep it running after you log out:  sudo loginctl enable-linger \"$USER\""
  echo "Pair your phone or another computer with:  beddcode pair"
  echo "Check everything with:  beddcode doctor   (it also lists the agent CLIs you still need)"
fi
