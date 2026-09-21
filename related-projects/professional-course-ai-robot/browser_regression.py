"""浏览器冒烟检查：加载学生端/教师端首页并收集控制台错误。

环境变量：
- AUDIT_BASE_URL：被测服务地址，默认 http://127.0.0.1:4173
- BROWSER_EXECUTABLE：浏览器可执行文件路径；留空时自动探测 Edge/Chrome，
  均未找到则使用 playwright 自带 chromium。
"""

import os

from playwright.sync_api import sync_playwright

BASE = os.environ.get("AUDIT_BASE_URL", "http://127.0.0.1:4173")

BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def resolve_browser_executable():
    override = os.environ.get("BROWSER_EXECUTABLE")
    if override:
        return override
    for candidate in BROWSER_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return None


def inspect(page, label):
    errors = []
    page.on("console", lambda msg: errors.append(f"console:{msg.type}:{msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(f"pageerror:{exc}\n{exc.stack}"))
    page.goto(f"{BASE}/{label}.html", wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(1200)
    buttons = page.locator("button").count()
    text = page.locator("body").inner_text()[:1200]
    return {"label": label, "buttons": buttons, "errors": errors, "text": text}


with sync_playwright() as p:
    executable = resolve_browser_executable()
    launch_kwargs = {"headless": True}
    if executable:
        launch_kwargs["executable_path"] = executable
    browser = p.chromium.launch(**launch_kwargs)
    for label in ("student", "teacher"):
        page = browser.new_page()
        print(str(inspect(page, label)).encode("ascii", "backslashreplace").decode("ascii"))
        page.close()
    browser.close()
