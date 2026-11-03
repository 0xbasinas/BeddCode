#!/usr/bin/env bash
# down.sh - runs LOCALLY. Ends a session without losing work or paying for an idle droplet:
#   1. lists uncommitted / unpushed work in the droplet's git repos and asks whether to go on
#   2. stops the BeddCode host, the emulator and the Gradle/Kotlin daemons
#   3. shuts the droplet down (graceful, hard power-off only if that fails)
#   4. takes a dated snapshot "<prefix>-YYYYMMDD-HHMM" and waits for it
#   5. deletes the droplet (asks you to type its name)
#   6. deletes snapshots beyond the newest $SNAPSHOTS_TO_KEEP, only after step 4 succeeded (asks each)
# Then prints the estimated monthly snapshot cost and month-to-date usage. Settings: ./config.env.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
confirm() { local a; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }

[ -f "$HERE/config.env" ] || die "missing $HERE/config.env"
# shellcheck source=/dev/null
. "$HERE/config.env"
command -v doctl >/dev/null || die "doctl not found on PATH"

row="$(doctl compute droplet list --format Name,ID,PublicIPv4,Status --no-header | awk -v n="$DROPLET_NAME" '$1==n')"
[ -n "$row" ] || die "no droplet named $DROPLET_NAME (already deleted? check: doctl compute droplet list)"
[ "$(wc -l <<< "$row")" = 1 ] || die "more than one droplet named $DROPLET_NAME; clean up by hand:"$'\n'"$row"
read -r _ id ip status <<< "$row"
log "Droplet $DROPLET_NAME: id $id, $ip, $status"
SSH=(ssh -i "$SSH_KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "$DEV_USER@$ip")

if [ "$status" = "active" ]; then
  log "1/6 Looking for uncommitted or unpushed work in ~/projects and ~/devbox"
  "${SSH[@]}" 'bash -s' <<'EOF' || echo "(could not check; SSH failed)"
found=0
while IFS= read -r g; do
  r="$(dirname "$g")"
  dirty="$(git -C "$r" status --porcelain 2>/dev/null | wc -l)"
  ahead="$(git -C "$r" rev-list --count '@{u}..HEAD' 2>/dev/null || echo '?')"
  if [ "$dirty" != 0 ] || [ "$ahead" != 0 ]; then
    echo "  $r: $dirty changed file(s), $ahead unpushed commit(s)"; found=1
  fi
done < <(find "$HOME/projects" "$HOME/devbox" -maxdepth 4 -name .git -type d 2>/dev/null)
[ "$found" = 0 ] && echo "  all clean"
EOF
  echo "(It is all kept in the snapshot either way; this is about not depending on one snapshot.)"
  confirm "Continue shutting down?" || die "stopped; nothing changed"

  log "2/6 Stopping services on the droplet"
  "${SSH[@]}" 'systemctl --user stop beddcode-server.service 2>/dev/null; \
    [ -x ~/bin/emu-stop.sh ] && ~/bin/emu-stop.sh >/dev/null 2>&1; \
    pkill -u "$USER" -f GradleDaemon; pkill -u "$USER" -f KotlinCompileDaemon; sync; echo stopped' || true

  log "3/6 Shutting down"
  confirm "Shut down $DROPLET_NAME now?" || die "stopped; services are stopped but the droplet is still on (and billing)"
  doctl compute droplet-action shutdown "$id" --wait >/dev/null \
    || { echo "graceful shutdown failed; hard power-off"; doctl compute droplet-action power-off "$id" --wait >/dev/null; }
fi

log "4/6 Snapshot"
snap="$SNAPSHOT_PREFIX-$(date +%Y%m%d-%H%M)"
echo "Creating $snap (this takes several minutes for ~30-50 GB)"
doctl compute droplet-action snapshot "$id" --snapshot-name "$snap" --wait >/dev/null \
  || die "snapshot failed. The droplet is OFF but still exists and still bills. Retry ./down.sh or snapshot it in the dashboard."
doctl compute snapshot list "$snap" --resource droplet --format Name --no-header | grep -qx "$snap" \
  || die "snapshot $snap is not listed. NOT deleting the droplet."
echo "Snapshot $snap is ready."

log "5/6 Delete the droplet"
read -r -p "Type the droplet name ($DROPLET_NAME) to delete it, anything else to keep it: " a
if [ "$a" = "$DROPLET_NAME" ]; then
  doctl compute droplet delete "$id" --force
  echo "Deleted $DROPLET_NAME."
else
  printf '\033[1;33mKept the droplet. A powered-off droplet still bills the full rate.\033[0m\n'
fi

log "6/6 Old snapshots (keeping the newest $SNAPSHOTS_TO_KEEP)"
old="$(doctl compute snapshot list "$SNAPSHOT_PREFIX-*" --resource droplet --format Name,ID --no-header \
  | sort -k1,1 -r | tail -n +"$((SNAPSHOTS_TO_KEEP + 1))")"
if [ -z "$old" ]; then
  echo "nothing to delete"
else
  while read -r name sid; do
    confirm "Delete old snapshot $name (id $sid)?" < /dev/tty && doctl compute image delete "$sid" --force && echo "deleted $name"
  done <<< "$old"
fi

log "Cost"
# Size column looks like "23.45 GiB"; billed at SNAPSHOT_USD_PER_GB per GB-month.
doctl compute snapshot list "$SNAPSHOT_PREFIX-*" --resource droplet --format Name,Size --no-header \
  | awk -v p="$SNAPSHOT_USD_PER_GB" '{ gb += $2; printf "  %s  %s GB\n", $1, $2 }
      END { printf "Snapshots: %.1f GB, about $%.2f per month\n", gb, gb * p }'
usage="$(doctl balance get --format MonthToDateUsage --no-header 2>/dev/null | tr -d '$ ' || true)"
[ -n "$usage" ] && echo "Month-to-date usage: \$$usage (warn threshold \$$BILLING_WARN_USD)"
echo
echo "Check: doctl compute droplet list   (should not list $DROPLET_NAME)"
