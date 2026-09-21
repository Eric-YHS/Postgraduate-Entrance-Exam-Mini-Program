#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="${YANBAN_RUNTIME_DIR:-$HOME/.local/share/yanban-ai}"
DATA_DIR="$RUNTIME_ROOT/data"
LOG_DIR="$DATA_DIR/logs"
API_URL="http://127.0.0.1:8000/api/health"
WEB_URL="http://127.0.0.1:4173/api/health"
API_PID_FILE="$RUNTIME_ROOT/api.pid"
WEB_PID_FILE="$RUNTIME_ROOT/web.pid"

mkdir -p "$LOG_DIR"
command -v python3 >/dev/null || { echo "缺少 Python 3，无法启动。" >&2; exit 1; }
command -v curl >/dev/null || { echo "缺少 curl，无法启动。" >&2; exit 1; }
command -v ss >/dev/null || { echo "缺少 ss，无法启动。" >&2; exit 1; }

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
    fi
    rm -f "$file"
  fi
}

ready() {
  curl --noproxy '*' --silent --fail --max-time 2 "$1" >/dev/null
}

# Remove only processes recorded by this project. A healthy service already
# listening on the expected port is reused, so repeated launches are safe.
API_OWNED=0
WEB_OWNED=0

if ready "$API_URL"; then
  echo "账号服务已在 8000 端口运行，复用现有服务。"
else
  if ss -ltn "sport = :8000" 2>/dev/null | grep -q ':8000'; then
    echo "端口 8000 已被占用且不是可用的研伴账号服务。" >&2
    exit 1
  fi
  : > "$LOG_DIR/server-runtime.stdout.log"
  nohup setsid env PYTHONPATH="$PROJECT_ROOT" \
      YANBAN_DATA_DIR="$DATA_DIR" \
      YANBAN_HOST=0.0.0.0 \
      YANBAN_PORT=8000 \
      python3 server.py </dev/null >> "$LOG_DIR/server-runtime.stdout.log" 2>&1 &
  API_PID=$!
  API_OWNED=1
  printf '%s\n' "$API_PID" > "$API_PID_FILE"
  for _ in $(seq 1 60); do
    if ! kill -0 "$API_PID" 2>/dev/null; then
      echo "账号服务进程已退出。日志：$LOG_DIR/server-runtime.stdout.log" >&2
      stop_pid_file "$API_PID_FILE"
      exit 1
    fi
    if ready "$API_URL"; then
      echo "账号服务已就绪。"
      break
    fi
    sleep 0.25
  done
  if ! kill -0 "$API_PID" 2>/dev/null || ! ready "$API_URL"; then
    echo "账号服务启动失败。日志：$LOG_DIR/server-runtime.stdout.log" >&2
    stop_pid_file "$API_PID_FILE"
    exit 1
  fi
fi

if ready "$WEB_URL"; then
  echo "网页服务已在 4173 端口运行，复用现有服务。"
else
  if ss -ltn "sport = :4173" 2>/dev/null | grep -q ':4173'; then
    echo "端口 4173 已被占用且不是可用的研伴网页服务。" >&2
    if [[ "$API_OWNED" == "1" ]]; then stop_pid_file "$API_PID_FILE"; fi
    exit 1
  fi
  nohup setsid env PYTHONPATH="$PROJECT_ROOT" \
      python3 local_proxy_server.py \
      --host 0.0.0.0 \
      --port 4173 </dev/null >> "$LOG_DIR/web-runtime.stdout.log" 2>&1 &
  WEB_PID=$!
  WEB_OWNED=1
  printf '%s\n' "$WEB_PID" > "$WEB_PID_FILE"
  for _ in $(seq 1 60); do
    if ! kill -0 "$WEB_PID" 2>/dev/null; then
      echo "网页服务进程已退出。日志：$LOG_DIR/web-runtime.stdout.log" >&2
      stop_pid_file "$WEB_PID_FILE"
      if [[ "$API_OWNED" == "1" ]]; then stop_pid_file "$API_PID_FILE"; fi
      exit 1
    fi
    if ready "$WEB_URL"; then
      echo "网页服务已就绪。"
      break
    fi
    sleep 0.25
  done
  if ! kill -0 "$WEB_PID" 2>/dev/null || ! ready "$WEB_URL"; then
    echo "网页服务启动失败。日志：$LOG_DIR/web-runtime.stdout.log" >&2
    stop_pid_file "$WEB_PID_FILE"
    if [[ "$API_OWNED" == "1" ]]; then stop_pid_file "$API_PID_FILE"; fi
    exit 1
  fi
fi

WSL_IP="$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' | head -n 1 || true)"
printf '%s\n' "$WSL_IP" > "$RUNTIME_ROOT/wsl-ip.txt"
echo "研伴 AI 后台已启动：账号注册、学生端和老师端均可使用。"
if [[ -n "$WSL_IP" ]]; then
  echo "WSL 网络地址：$WSL_IP"
fi
