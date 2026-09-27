#!/usr/bin/env bash
# Back up the indexer's canonical ledger (state.json + events.jsonl). The ledger
# is deterministically replayable from chain, but backups make recovery instant
# and let you audit history. Run from cron every ~10 min:
#   */10 * * * * /opt/arc20/ops/backup.sh >> /var/log/arc20-backup.log 2>&1
set -euo pipefail

SRC="${SRC:-/opt/arc20/indexer}"
DEST="${DEST:-/opt/arc20/backups}"
KEEP="${KEEP:-288}"   # keep last N snapshots (288 * 10min ≈ 2 days)

mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/ledger-$STAMP.tar.gz"

# state.json is written atomically (tmp+rename) by the indexer, so a copy is consistent.
# events.jsonl only exists once there has been inscription activity — back up whatever
# is present, but skip entirely only if the critical state.json isn't there yet.
[ -f "$SRC/state.json" ] || { echo "$(date -u +%FT%TZ) backup skipped (no state.json yet)"; exit 0; }
files=(state.json)
[ -f "$SRC/events.jsonl" ] && files+=(events.jsonl)
tar -czf "$OUT" -C "$SRC" "${files[@]}" 2>/dev/null || {
  echo "$(date -u +%FT%TZ) backup failed (tar error)"; exit 1; }

# prune old snapshots
ls -1t "$DEST"/ledger-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "$(date -u +%FT%TZ) backed up -> $OUT ($(du -h "$OUT" | cut -f1))"
