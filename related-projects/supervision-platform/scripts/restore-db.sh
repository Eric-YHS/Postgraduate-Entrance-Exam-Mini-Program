#!/usr/bin/env sh
set -eu

: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${ALLOW_DESTRUCTIVE_RESTORE:?set ALLOW_DESTRUCTIVE_RESTORE=true to confirm destructive restore}"
[ "$ALLOW_DESTRUCTIVE_RESTORE" = "true" ] || { echo "ALLOW_DESTRUCTIVE_RESTORE must equal true" >&2; exit 2; }
BACKUP_FILE=${1:?usage: RESTORE_DATABASE_URL=... ALLOW_DESTRUCTIVE_RESTORE=true ./scripts/restore-db.sh backups/shangan-<timestamp>.dump}

case "$BACKUP_FILE" in
  *.dump) ;;
  *) echo "backup must be a pg_dump custom-format .dump file" >&2; exit 2 ;;
esac
[ -f "$BACKUP_FILE" ] || { echo "backup file not found: $BACKUP_FILE" >&2; exit 2; }

CHECKSUM_FILE="$BACKUP_FILE.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
  (cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$CHECKSUM_FILE")")
fi
pg_restore --list "$BACKUP_FILE" >/dev/null
TARGET=$(printf '%s' "$RESTORE_DATABASE_URL" | sed -E 's#(postgres(ql)?://)[^@/]+@([^/]+)/?.*#\3#')
printf 'restoring %s to %s\n' "$BACKUP_FILE" "$TARGET"
pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
printf 'restore complete: %s\n' "$BACKUP_FILE"
