#!/usr/bin/env python3
"""Local development web server: static files plus same-origin /api proxy."""
from __future__ import annotations

import argparse
import http.client
import json
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOP_BY_HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}


class LocalProxyHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _proxy_api(self):
        body_length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(body_length) if body_length else None
        headers = {key: value for key, value in self.headers.items() if key.lower() not in HOP_BY_HOP_HEADERS | {"host", "content-length"}}
        if body is not None:
            headers["Content-Length"] = str(len(body))
        try:
            connection = http.client.HTTPConnection("127.0.0.1", 8000, timeout=300)
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read()
        except OSError:
            message = json.dumps({"error": "api_unavailable", "message": "学习服务尚未启动，请等待本地启动完成后重试。"}, ensure_ascii=False).encode("utf-8")
            self.send_response(503)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)
            return
        self.send_response(response.status, response.reason)
        for key, value in response.getheaders():
            if key.lower() not in HOP_BY_HOP_HEADERS | {"content-length", "access-control-allow-origin", "vary"}:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path.rstrip('/') or '/'
        if route.startswith("/api/"):
            self._proxy_api()
            return
        # Keep launcher/browser variants on a single, known page. This avoids
        # a static-server 404 when a Windows launcher opens the bare local URL.
        if route in {"/", "/student", "/student/index.html"}:
            self.path = "/student.html" + (f"?{parsed.query}" if parsed.query else "")
        elif route == "/teacher":
            self.path = "/teacher.html" + (f"?{parsed.query}" if parsed.query else "")
        elif route not in {"/student.html", "/teacher.html", "/subject_directory.js"} and not route.startswith("/assets/"):
            # A stale launcher can still request an old page name. Keep the
            # local app usable instead of exposing a generic static 404.
            self.path = "/student.html" + (f"?{parsed.query}" if parsed.query else "")
        super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path.startswith("/api/"):
            self._proxy_api()
            return
        self.send_error(404)

    def do_DELETE(self):
        if urllib.parse.urlparse(self.path).path.startswith("/api/"):
            self._proxy_api()
            return
        self.send_error(404)

    def do_OPTIONS(self):
        if urllib.parse.urlparse(self.path).path.startswith("/api/"):
            self._proxy_api()
            return
        self.send_response(204)
        self.end_headers()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()
    handler = lambda *handler_args, **handler_kwargs: LocalProxyHandler(*handler_args, directory=str(ROOT), **handler_kwargs)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Local web + API proxy: http://{args.host}:{args.port}/student.html", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
