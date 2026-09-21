#!/usr/bin/env python3
"""Reliable Windows local launcher for Yanban AI."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP_DATA = Path(os.environ.get("LOCALAPPDATA", str(ROOT / ".runtime"))) / "YanbanAI"
DATA_DIR = APP_DATA / "data"
LOG_DIR = APP_DATA / "logs"
PID_FILE = APP_DATA / "yanban-local-pids.json"


def write_launcher_log(text: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with (LOG_DIR / "launcher.log").open("a", encoding="utf-8") as handle:
        handle.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}]\n{text}\n")


def project_health(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return response.status == 200 and payload.get("ok") is True and payload.get("service") == "yanban-api"
    except Exception:
        return False


def wait_for_health(url: str, seconds: int) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if project_health(url):
            return True
        time.sleep(0.25)
    return False


def managed_service_is_ready() -> bool:
    return project_health("http://127.0.0.1:4173/api/health")


def launch_services(env: dict[str, str]) -> None:
    api_log = (LOG_DIR / "api.log").open("a", encoding="utf-8")
    web_log = (LOG_DIR / "web.log").open("a", encoding="utf-8")
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    print("正在启动账号服务…", flush=True)
    api = subprocess.Popen([sys.executable, "server.py"], cwd=ROOT, env=env, stdout=api_log, stderr=subprocess.STDOUT, creationflags=creationflags)
    if not wait_for_health("http://127.0.0.1:8000/api/health", 20):
        raise RuntimeError(f"账号服务未启动。请查看：{LOG_DIR / 'api.log'}")
    print("正在启动网页服务…", flush=True)
    web = subprocess.Popen([sys.executable, "local_proxy_server.py", "--port", "4173"], cwd=ROOT, env=env, stdout=web_log, stderr=subprocess.STDOUT, creationflags=creationflags)
    if not wait_for_health("http://127.0.0.1:4173/api/health", 15):
        raise RuntimeError(f"网页服务未启动。请查看：{LOG_DIR / 'web.log'}")
    PID_FILE.write_text(json.dumps({"api": api.pid, "web": web.pid}), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("page", choices=("student", "teacher"))
    args = parser.parse_args()
    if not (ROOT / "server.py").is_file() or not (ROOT / "local_proxy_server.py").is_file():
        raise RuntimeError(f"启动文件不完整，请确认项目文件夹存在：{ROOT}")
    if not Path(sys.executable).is_file():
        raise RuntimeError("未找到可用的 Python 3。")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    probe = DATA_DIR / ".write-check"
    probe.write_text("ok", encoding="utf-8")
    probe.unlink()
    env = os.environ.copy()
    env.update({"YANBAN_DATA_DIR": str(DATA_DIR), "YANBAN_HOST": "127.0.0.1", "YANBAN_PORT": "8000"})
    print(f"Python：{sys.executable}", flush=True)
    print(f"账号数据：{DATA_DIR}", flush=True)
    if managed_service_is_ready():
        print("本地服务已运行，直接打开对应端。", flush=True)
    else:
        launch_services(env)
    page = "teacher.html" if args.page == "teacher" else "student.html"
    url = f"http://127.0.0.1:4173/{page}?fresh={int(time.time())}"
    print("启动成功，正在打开浏览器…", flush=True)
    webbrowser.open(url)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        details = f"{error}\n\n{traceback.format_exc()}"
        try:
            write_launcher_log(details)
        except Exception:
            pass
        print(f"启动失败：{error}", flush=True)
        print(f"详细日志：{LOG_DIR / 'launcher.log'}", flush=True)
        raise SystemExit(1)
