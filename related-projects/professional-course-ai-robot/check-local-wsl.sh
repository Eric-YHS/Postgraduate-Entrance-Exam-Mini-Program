#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="${YANBAN_RUNTIME_DIR:-$HOME/.local/share/yanban-ai}"
LOG_DIR="$RUNTIME_ROOT/data/logs"
API_SESSION="yanban-ai-api"
WEB_SESSION="yanban-ai-web"

show_session() {
  local session="$1"
  if tmux has-session -t "$session" 2>/dev/null; then
    printf '%-18s running\n' "$session"
  else
    printf '%-18s stopped\n' "$session"
  fi
}

show_http() {
  local label="$1"
  local url="$2"
  if curl --silent --show-error --fail --max-time 2 "$url" >/dev/null; then
    printf '%-18s healthy (%s)\n' "$label" "$url"
  else
    printf '%-18s unavailable (%s)\n' "$label" "$url"
  fi
}

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required but is not available in this WSL distribution." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but is not available in this WSL distribution." >&2
  exit 1
fi

echo "Yanban AI WSL service status"
show_session "$API_SESSION"
show_session "$WEB_SESSION"
show_http "API" "http://127.0.0.1:8000/api/health"
show_http "Student web" "http://127.0.0.1:4173/student.html"

if ! curl --silent --show-error --fail --max-time 2 "http://127.0.0.1:8000/api/health" >/dev/null; then
  echo
  echo "Recent API log:"
  tail -n 30 "$LOG_DIR/server-runtime.stdout.log" 2>/dev/null || true
fi

if ! curl --silent --show-error --fail --max-time 2 "http://127.0.0.1:4173/student.html" >/dev/null; then
  echo
  echo "Recent web log:"
  tail -n 30 "$LOG_DIR/web-runtime.stdout.log" 2>/dev/null || true
fi
