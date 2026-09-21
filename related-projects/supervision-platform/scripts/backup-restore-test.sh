#!/usr/bin/env sh
set -eu

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required (the database to back up)}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required (a temporary database used for restore verification)}"

TARGET_HOST=$(printf '%s' "$TARGET_DATABASE_URL" | sed -E 's#postgres(ql)?://[^@/]+@([^/]+)/.*#\2#')
TARGET_DB=$(printf '%s' "$TARGET_DATABASE_URL" | sed -E 's#.*/##' | sed -E 's#\?.*$##')
printf 'verify restore against %s on %s\n' "$TARGET_DB" "$TARGET_HOST"

# Drop and recreate the target database so the script is idempotent.
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TARGET_DB}' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
DROPDB=$(printf '%s' "$TARGET_DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres\1#')
psql "$DROPDB" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\"" >/dev/null
psql "$DROPDB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${TARGET_DB}\"" >/dev/null

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM
BACKUP_FILE="$WORK_DIR/backup.dump"

BACKUP_DIR="$WORK_DIR" DATABASE_URL="$SOURCE_DATABASE_URL" ./scripts/backup-db.sh
LATEST=$(ls -1t "$WORK_DIR"/shangan-*.dump | head -1)
[ -n "$LATEST" ] || [ -f "$BACKUP_FILE" ] || cp "$WORK_DIR"/shangan-*.dump "$BACKUP_FILE" 2>/dev/null || true
[ -f "$LATEST" ] && BACKUP_FILE="$LATEST"
RESTORE_DATABASE_URL="$TARGET_DATABASE_URL" ALLOW_DESTRUCTIVE_RESTORE=true ./scripts/restore-db.sh "$BACKUP_FILE"

# Compare counts of the most important tables.
COUNT_QUERY=$(cat <<'SQL'
SELECT 'accounts', (SELECT COUNT(*) FROM accounts)
UNION ALL SELECT 'students', (SELECT COUNT(*) FROM students)
UNION ALL SELECT 'orders', (SELECT COUNT(*) FROM orders)
UNION ALL SELECT 'entitlements', (SELECT COUNT(*) FROM entitlements)
UNION ALL SELECT 'assessment_records', (SELECT COUNT(*) FROM assessment_records)
UNION ALL SELECT 'community_posts', (SELECT COUNT(*) FROM community_posts)
UNION ALL SELECT 'student_plans', (SELECT COUNT(*) FROM student_plans)
UNION ALL SELECT 'task_completions', (SELECT COUNT(*) FROM task_completions);
SQL
)
SOURCE_COUNTS=$(psql "$SOURCE_DATABASE_URL" -t -A -F'|' -c "$COUNT_QUERY")
TARGET_COUNTS=$(psql "$TARGET_DATABASE_URL" -t -A -F'|' -c "$COUNT_QUERY")
if [ "$SOURCE_COUNTS" != "$TARGET_COUNTS" ]; then
  printf 'row count mismatch\nsource:\n%s\n\ntarget:\n%s\n' "$SOURCE_COUNTS" "$TARGET_COUNTS" >&2
  exit 1
fi

printf 'backup restore drill succeeded: %s\n' "$BACKUP_FILE"
