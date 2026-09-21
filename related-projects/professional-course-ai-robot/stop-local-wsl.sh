#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="${YANBAN_RUNTIME_DIR:-$HOME/.local/share/yanban-ai}"
API_PID_FILE="$RUNTIME_ROOT/api.pid"
WEB_PID_FILE="$RUNTIME_ROOT/web.pid"

stop_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -9 "$pid" 2>/dev/null || true
      printf 'Stopped process %s.\n' "$pid"
    fi
    rm -f "$file"
  fi
}

stop_pid_file "$API_PID_FILE"
stop_pid_file "$WEB_PID_FILE"
echo "Yanban AI local services stopped."
