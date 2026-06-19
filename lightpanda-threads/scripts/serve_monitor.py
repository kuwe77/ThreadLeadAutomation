#!/usr/bin/env python3
"""Standalone Lightpanda monitor dashboard server.

Serves only files from ~/.hermes/lightpanda-threads/monitor and JSON status from
~/.hermes/lightpanda-threads/state. This does not touch the live Next dashboard.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
MONITOR_DIR = ROOT / "monitor"
STATE_DIR = ROOT / "state"
STATUS_PATH = STATE_DIR / "status.json"
HISTORY_PATH = STATE_DIR / "runs.jsonl"
IMPORT_REPORT_PATH = STATE_DIR / "import-report.json"
CONFIG_PATH = ROOT / "finder_config.json"
LEGACY_CONFIG_PATH = ROOT / "config.json"


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def read_runs(limit: int = 30):
    if not HISTORY_PATH.exists():
        return []
    lines = HISTORY_PATH.read_text(encoding="utf-8").splitlines()[-limit:]
    runs = []
    for line in lines:
        try:
            runs.append(json.loads(line))
        except Exception:
            continue
    return list(reversed(runs))


class Handler(BaseHTTPRequestHandler):
    server_version = "LightpandaThreadsMonitor/0.1"

    def send_json(self, payload, status: int = 200):
        body = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib API
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            return self.send_json(
                {
                    "status": read_json(STATUS_PATH, None),
                    "importReport": read_json(IMPORT_REPORT_PATH, None),
                    "config": public_config(),
                }
            )
        if parsed.path == "/api/runs":
            return self.send_json({"runs": read_runs()})
        if parsed.path in {"/", "/index.html"}:
            return self.serve_file(MONITOR_DIR / "index.html")
        candidate = (MONITOR_DIR / parsed.path.lstrip("/")).resolve()
        if MONITOR_DIR.resolve() in candidate.parents and candidate.exists() and candidate.is_file():
            return self.serve_file(candidate)
        return self.send_json({"error": "not found"}, status=404)

    def serve_file(self, path: Path):
        try:
            body = path.read_bytes()
        except FileNotFoundError:
            return self.send_json({"error": "not found"}, status=404)
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), fmt % args))


def public_config():
    config = read_json(CONFIG_PATH, {}) or read_json(LEGACY_CONFIG_PATH, {})
    return {
        "name": config.get("name"),
        "browserSource": config.get("browserSource", "PandaBrowser/Lightpanda"),
        "baseUrl": config.get("baseUrl"),
        "searchWaitSeconds": config.get("searchWaitSeconds"),
        "postWaitSeconds": config.get("postWaitSeconds"),
        "maxKeywordsPerAccount": config.get("maxKeywordsPerAccount"),
        "maxCandidatesPerAccount": config.get("maxCandidatesPerAccount"),
        "sendTelegram": config.get("sendTelegram"),
        "autoComment": config.get("autoComment"),
        "accounts": [
            {
                "id": a.get("id"),
                "label": a.get("label"),
                "handle": a.get("handle"),
                "enabled": a.get("enabled"),
                "intentMode": a.get("intentMode"),
                "keywordCount": len(a.get("keywords") or []),
                "cookiesPath": a.get("baseCookiesPath") or a.get("cookiesPath"),
            }
            for a in config.get("accounts", [])
        ],
        "safety": config.get("safety"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve Lightpanda monitor dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5057)
    args = parser.parse_args()
    MONITOR_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Lightpanda monitor dashboard: http://{args.host}:{args.port}/")
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
