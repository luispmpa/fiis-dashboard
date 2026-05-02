import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

from xp_sync.dashboard_service import get_dashboard


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/dashboard":
            try:
                self._send_json(200, get_dashboard())
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})
            return
        self._send_json(404, {"error": "not found"})


def main():
    server = HTTPServer(("0.0.0.0", 8000), Handler)
    print("API rodando em http://0.0.0.0:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
