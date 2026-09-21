#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR=${BACKUP_DIR:-backups}
RETENTION_DAYS=${RETENTION_DAYS:-14}
LOCK_DIR="${BACKUP_DIR}/.backup.lock"
mkdir -p "$BACKUP_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "another backup is already running" >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR"' EXIT INT TERM

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/shangan-${STAMP}.dump"
CHECKSUM="$FILE.sha256"

pg_dump "$DATABASE_URL" --format=custom --file="$FILE"
pg_restore --list "$FILE" >/dev/null
sha256sum "$FILE" > "$CHECKSUM"
find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.dump.sha256' \) -mtime +"$RETENTION_DAYS" -print -delete
printf 'backup complete: %s\nchecksum: %s\n' "$FILE" "$CHECKSUM"
