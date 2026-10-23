"""浏览器调试服务器：不开 PyWebView 窗口，用普通浏览器调试前端.

用法：uv run python scripts/dev_server.py [端口，默认 8765]
然后浏览器打开 http://127.0.0.1:8765/index.html?dev=1

web/dev-bridge.js 在 ?dev=1 时用 fetch 模拟 window.pywebview.api，
请求转发到 backend.Api 的同名方法。保存 / 打开文件的对话框在此模式下不可用。
"""
from __future__ import annotations

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import backend  # noqa: E402

API = backend.Api()
WEB = os.path.join(ROOT, "web")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):  # 安静一点
        if "/api/" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    def do_POST(self):
        if not self.path.startswith("/api/"):
            self.send_error(404)
            return
        name = self.path[len("/api/"):]
        if name.startswith("_") or not hasattr(API, name):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        args = json.loads(self.rfile.read(length) or b"[]")
        try:
            result = getattr(API, name)(*args)
        except Exception as exc:  # 调试模式：把错误返回给前端
            result = {"error": f"{type(exc).__name__}: {exc}"}
        body = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"SeedBoxes 调试服务器：http://127.0.0.1:{port}/index.html?dev=1")
    srv.serve_forever()


if __name__ == "__main__":
    main()
