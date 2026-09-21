"""Run dependency-free local checks without starting the application.

Usage: python scripts/verify_local.py

Paths and executables can be overridden with environment variables:
YANBAN_PROJECT_ROOT, YANBAN_PYTHON, YANBAN_NODE, YANBAN_HTML_FILES,
YANBAN_DOCKERFILE, YANBAN_DOCKERIGNORE, YANBAN_NGINX_CONFIG. Set
YANBAN_REQUIRE_DOCKERIGNORE=0 only when a caller deliberately accepts Docker's
full build context (the secure default is to require a .dockerignore).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(os.getenv("YANBAN_PROJECT_ROOT", str(Path(__file__).resolve().parents[1]))).expanduser().resolve()
PYTHON = os.getenv("YANBAN_PYTHON", sys.executable)
NODE = os.getenv("YANBAN_NODE", "node")
HTML_FILES = [
    Path(item.strip())
    for item in os.getenv("YANBAN_HTML_FILES", "student.html,teacher.html").split(",")
    if item.strip()
]
DOCKERFILE = Path(os.getenv("YANBAN_DOCKERFILE", "Dockerfile"))
DOCKERIGNORE = Path(os.getenv("YANBAN_DOCKERIGNORE", ".dockerignore"))
NGINX_CONFIG = Path(os.getenv("YANBAN_NGINX_CONFIG", "deploy/nginx.conf"))
REQUIRE_DOCKERIGNORE = os.getenv("YANBAN_REQUIRE_DOCKERIGNORE", "1").strip().lower() not in {"0", "false", "no"}

# Do not allow a checked-in source/config file to depend on a developer's
# machine. These patterns intentionally cover both Windows and Unix forms.
PERSONAL_PATH_PATTERNS = (
    re.compile(r"[A-Za-z]:[\\/]Users[\\/][^\\/\s]+", re.I),
    re.compile(r"/(?:home|Users|mnt/[a-z])/[A-Za-z0-9_.-]+", re.I),
)
SECRET_LITERAL_PATTERNS = (
    re.compile(r"(?i)\b(?:api[_-]?key|admin[_-]?token|password)\s*[:=]\s*['\"]?[^\s'\"]{8,}"),
    re.compile(r"(?i)COPY\s+[^\n]*\.env(?:\s|$)"),
)


def resolve_configured(value: Path) -> Path:
    return value if value.is_absolute() else ROOT / value


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def check_python_compile() -> list[str]:
    failures = []
    sources = sorted(path for path in ROOT.rglob("*.py") if "__pycache__" not in path.parts)
    if not sources:
        return ["未找到 Python 源文件"]
    # py_compile normally writes __pycache__ beside each source. Keep this
    # verification side-effect free by redirecting bytecode to a temp tree.
    with tempfile.TemporaryDirectory(prefix="yanban-pycache-") as pycache:
        compile_env = {**os.environ, "PYTHONPYCACHEPREFIX": pycache}
        for source in sources:
            try:
                result = subprocess.run(
                    [PYTHON, "-m", "py_compile", str(source)],
                    cwd=ROOT,
                    env=compile_env,
                    text=True,
                    capture_output=True,
                )
            except OSError as error:
                return [f"无法运行 Python 编译器 {PYTHON}: {type(error).__name__}"]
            if result.returncode:
                detail = (result.stderr or result.stdout).strip().splitlines()[-1:]
                failures.append(f"Python 编译失败: {display_path(source)} {detail[0] if detail else ''}".strip())
    return failures


def inline_scripts(path: Path) -> list[str]:
    source = path.read_text(encoding="utf-8")
    scripts = []
    for match in re.finditer(r"<script\b([^>]*)>(.*?)</script\s*>", source, re.I | re.S):
        attrs, body = match.group(1), match.group(2)
        if re.search(r"\bsrc\s*=", attrs, re.I):
            continue
        type_match = re.search(r"\btype\s*=\s*(['\"])(.*?)\1", attrs, re.I | re.S)
        script_type = type_match.group(2).strip().lower() if type_match else "text/javascript"
        if script_type not in {"", "text/javascript", "application/javascript", "module"}:
            continue
        scripts.append(body)
    return scripts


def check_inline_javascript() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="yanban-inline-js-") as temp_dir:
        for configured in HTML_FILES:
            path = resolve_configured(configured)
            if not path.is_file():
                failures.append(f"HTML 文件不存在: {path}")
                continue
            try:
                scripts = inline_scripts(path)
            except (OSError, UnicodeError) as error:
                failures.append(f"HTML 读取失败: {path} ({type(error).__name__})")
                continue
            if not scripts:
                failures.append(f"未找到可检查的内联 JavaScript: {display_path(path)}")
                continue
            for index, body in enumerate(scripts, 1):
                script_path = Path(temp_dir) / f"{path.stem}-{index}.js"
                script_path.write_text(body, encoding="utf-8")
                try:
                    result = subprocess.run([NODE, "--check", str(script_path)], cwd=ROOT, text=True, capture_output=True)
                except OSError as error:
                    failures.append(f"无法运行 Node 语法检查器 {NODE}: {type(error).__name__}")
                    break
                if result.returncode:
                    # Preserve the useful syntax location but avoid dumping HTML
                    # or arbitrary source content into a CI log.
                    detail = (result.stderr or result.stdout).strip().splitlines()[-1:]
                    failures.append(f"内联 JS 语法失败: {display_path(path)} script#{index} {detail[0] if detail else ''}".strip())
    return failures


def check_no_personal_paths(path: Path, label: str) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        return [f"{label} 读取失败: {path} ({type(error).__name__})"]
    failures = []
    for pattern in PERSONAL_PATH_PATTERNS:
        if pattern.search(text):
            failures.append(f"{label} 含个人绝对路径: {display_path(path)}")
            break
    return failures


def check_docker() -> list[str]:
    path = resolve_configured(DOCKERFILE)
    failures = check_no_personal_paths(path, "Dockerfile")
    if not path.is_file():
        return failures
    text = path.read_text(encoding="utf-8")
    for pattern in SECRET_LITERAL_PATTERNS:
        if pattern.search(text):
            failures.append(f"Dockerfile 含敏感配置或 .env 复制规则: {display_path(path)}")
            break
    if REQUIRE_DOCKERIGNORE:
        dockerignore = resolve_configured(DOCKERIGNORE)
        if not dockerignore.is_file():
            failures.append("缺少 .dockerignore，Docker COPY . 可能把 .env、数据库或上传资料带入镜像")
        else:
            ignore_text = dockerignore.read_text(encoding="utf-8")
            ignored = {line.strip().rstrip("/") for line in ignore_text.splitlines() if line.strip() and not line.lstrip().startswith("#")}
            # Docker ignore patterns commonly use a trailing slash for
            # directories; normalize it before checking the required rules.
            required = {".env", "data", "*.sqlite3", "*.sqlite3-*"}
            missing = [entry for entry in sorted(required) if entry not in ignored]
            if missing:
                failures.append(f".dockerignore 未忽略敏感路径: {', '.join(missing)}")
    return failures


def check_nginx() -> list[str]:
    path = resolve_configured(NGINX_CONFIG)
    failures = check_no_personal_paths(path, "Nginx 配置")
    if not path.is_file():
        return failures
    text = path.read_text(encoding="utf-8")
    extension_rule = re.search(r"location\s+~\*[^\n]*\\\.[^\n]*\benv\b[^\n]*\b(?:db|sqlite3)\b", text, re.I)
    if not extension_rule:
        failures.append("Nginx 未发现 .env/db/sqlite3 敏感扩展名拦截规则")
    # Accept either a dedicated /data/ location or a grouped sensitive-path
    # regex, but require deny all in the same location block.
    data_rule = re.search(r"location\s+(?:/data/|~\*[^\n]*data)[^\{]*\{[^}]*deny\s+all", text, re.I | re.S)
    if not data_rule:
        failures.append("Nginx 未禁止 /data/ 公开访问")
    if re.search(r"(?:alias|root)\s+[A-Za-z]:[\\/]", text, re.I):
        failures.append("Nginx root/alias 使用 Windows 个人绝对路径")
    return failures


def run_check(name: str, callback) -> int:
    failures = callback()
    if failures:
        print(f"[FAIL] {name}")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"[PASS] {name}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run isolated local source/config checks")
    parser.parse_args()
    results = [
        run_check("Python 编译", check_python_compile),
        run_check("HTML 内联 JavaScript 语法", check_inline_javascript),
        run_check("Docker 敏感路径规则", check_docker),
        run_check("Nginx 敏感路径规则", check_nginx),
    ]
    print(f"检查根目录: {ROOT}")
    return 1 if any(results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
