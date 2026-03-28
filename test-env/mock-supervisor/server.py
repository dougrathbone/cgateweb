#!/usr/bin/env python3
"""
Minimal mock of the Home Assistant Supervisor HTTP API.
Serves /addons/self/options/config from /data/options.json so that
bashio::config works without a real Supervisor.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

OPTIONS_FILE = "/data/options.json"


def load_options():
    with open(OPTIONS_FILE) as f:
        return json.load(f)


class SupervisorHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[mock-supervisor] {fmt % args}", flush=True)

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/addons/self/options/config", "/addons/self/options"):
            try:
                options = load_options()
                self.send_json(200, {"data": options, "result": "ok"})
            except Exception as e:
                self.send_json(500, {"result": "error", "message": str(e)})

        elif self.path == "/addons/self/info":
            self.send_json(200, {
                "data": {
                    "slug": "cgateweb",
                    "name": "C-Gate Web Bridge",
                    "version": "dev",
                    "state": "started",
                    "hostname": "addon_cgateweb",
                    "options": load_options(),
                },
                "result": "ok",
            })

        elif self.path == "/info":
            self.send_json(200, {
                "data": {
                    "supervisor": "dev",
                    "homeassistant": "dev",
                    "hassos": None,
                    "hostname": "homeassistant",
                    "machine": "generic-x86-64",
                    "arch": "amd64",
                },
                "result": "ok",
            })

        else:
            self.log_message("Unhandled GET %s", self.path)
            self.send_json(404, {"result": "error", "message": f"Not found: {self.path}"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 80))
    print(f"[mock-supervisor] Starting on port {port}", flush=True)
    print(f"[mock-supervisor] Reading options from {OPTIONS_FILE}", flush=True)
    server = HTTPServer(("0.0.0.0", port), SupervisorHandler)
    server.serve_forever()
