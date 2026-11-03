#!/usr/bin/env bash
# up.sh - runs LOCALLY (Git Bash on Windows, or any bash with doctl + ssh). Creates the dev droplet
# from your newest "$SNAPSHOT_PREFIX-*" snapshot, waits until SSH and the BeddCode host answer,
# and prints how to connect. Settings come from ./config.env.
#
#   ./up.sh            restore from the newest snapshot (normal session start)
#   ./up.sh --fresh    first time only: create from the plain Ubuntu image, then run bootstrap.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$HERE/config.env" ] || die "missing $HERE/config.env (copy config.env.example and edit it)"
# shellcheck source=/dev/null
. "$HERE/config.env"
command -v doctl >/dev/null || die "doctl not found on PATH"
doctl account get >/dev/null 2>&1 || die "doctl is not authenticated (run: doctl auth init)"

fresh=0
[ "${1:-}" = "--fresh" ] && fresh=1

existing="$(doctl compute droplet list --format Name,ID,PublicIPv4 --no-header | awk -v n="$DROPLET_NAME" '$1==n')"
[ -z "$existing" ] || die "a droplet named $DROPLET_NAME already exists: $existing (run down.sh first, or connect to it)"

if [ "$fresh" = 1 ]; then
  image="$BASE_IMAGE"; user="root"
  log "Fresh droplet from $image"
else
  log "Finding the newest $SNAPSHOT_PREFIX-* snapshot"
  # Names are <prefix>-YYYYMMDD-HHMM, so a name sort is a date sort.
  row="$(doctl compute snapshot list "$SNAPSHOT_PREFIX-*" --resource droplet --format Name,ID,Size --no-header | sort -k1,1 | tail -1)"
  [ -n "$row" ] || die "no snapshot named $SNAPSHOT_PREFIX-* (first time? use ./up.sh --fresh)"
  read -r snap_name image snap_size <<< "$row"
  user="$DEV_USER"
  log "Using $snap_name (id $image, ${snap_size})"
fi

log "Creating $DROPLET_NAME ($DROPLET_SIZE in $DROPLET_REGION)"
doctl compute droplet create "$DROPLET_NAME" --image "$image" --size "$DROPLET_SIZE" \
  --region "$DROPLET_REGION" --ssh-keys "$SSH_KEY_IDS" --wait \
  --format ID,Name,PublicIPv4,Status --no-header
ip="$(doctl compute droplet list --format Name,PublicIPv4 --no-header | awk -v n="$DROPLET_NAME" '$1==n {print $2}')"
[ -n "$ip" ] || die "droplet created but it has no public IP yet; check: doctl compute droplet list"

# Each droplet gets new host keys (cloud-init) and often a recycled IP, so forget the old entry.
mkdir -p "$HERE/.state"
ssh-keygen -R "$ip" >/dev/null 2>&1 || true
echo "$ip" > "$HERE/.state/ip"
SSH=(ssh -i "$SSH_KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "$user@$ip")

log "Waiting for SSH on $ip"
for i in $(seq 1 60); do
  "${SSH[@]}" true 2>/dev/null && break
  [ "$i" = 60 ] && die "SSH did not come up after 5 minutes; check the droplet console in the DO dashboard"
  sleep 5
done
"${SSH[@]}" 'cloud-init status --wait >/dev/null 2>&1 || true'

if [ "$fresh" = 1 ]; then
  log "Copying setup files; next step is bootstrap.sh"
  scp -q -i "$SSH_KEY_FILE" -r "$HERE" "root@$ip:/root/devbox"
  echo
  echo "Run the one-time setup (takes ~15-25 min):"
  echo "  ssh -i $SSH_KEY_FILE root@$ip 'bash /root/devbox/bootstrap.sh'"
  echo "After it, root login is off; use: ssh $DEV_USER@$ip"
else
  log "Checking the BeddCode host"
  "${SSH[@]}" 'systemctl --user is-active beddcode-server.service && beddcode host status' \
    || echo "The host is not running yet: ssh in and run 'journalctl --user -u beddcode-server -e'"
fi

usage="$(doctl balance get --format MonthToDateUsage --no-header 2>/dev/null | tr -d '$ ' || true)"
if [ -n "$usage" ]; then
  echo "Month-to-date usage: \$$usage"
  awk -v u="$usage" -v w="$BILLING_WARN_USD" 'BEGIN { exit !(u > w) }' \
    && printf '\033[1;33mWARNING: above your $%s threshold.\033[0m\n' "$BILLING_WARN_USD"
fi

cat <<EOF

Ready.  ssh $user@$ip          (tmux: tmux new -A -s main)
BeddCode desktop/phone reach it through the relay; nothing to change for the new IP.
When done:  ./down.sh   (a forgotten droplet bills until the monthly cap)
EOF
