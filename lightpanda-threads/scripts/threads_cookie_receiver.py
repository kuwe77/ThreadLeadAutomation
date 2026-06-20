#!/usr/bin/env python3
"""One-time Threads cookie receiver for remote laptop login.

Run on VPS. Serves a Windows Node.js login script and accepts one uploaded
Playwright storageState/cookie JSON. The upload is converted/stored for the
configured account without printing cookie values.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[1]
STORE_SCRIPT = ROOT / "scripts" / "store_uploaded_cookies.py"
STATE_DIR = ROOT / "state" / "cookie-login-upload"
TOKEN_FILE = STATE_DIR / "receiver-token.txt"
LAST_UPLOAD = STATE_DIR / "last-upload.json"

NODE_TEMPLATE = r'''
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const UPLOAD_URL = '__UPLOAD_URL__';
const TOKEN = '__TOKEN__';

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

(async () => {
  console.log('Opening Threads login browser...');
  console.log('1) Login to the Threads account you want.');
  console.log('2) Make sure you can see Threads logged-in homepage/profile.');
  console.log('3) Come back to this terminal and press Enter.');

  const userDataDir = path.join(process.cwd(), 'threads-login-browser-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.threads.net/login', { waitUntil: 'domcontentloaded' });

  await ask('\nAfter login is complete, press Enter here to save cookies to VPS...');

  const state = await context.storageState();
  const threadsCookies = (state.cookies || []).filter((c) => String(c.domain || '').includes('threads.net') || String(c.domain || '').includes('instagram.com'));
  if (!threadsCookies.length) {
    console.error('No Threads/Instagram cookies found. Are you logged in?');
    await context.close();
    process.exit(2);
  }

  const payload = JSON.stringify({ cookies: state.cookies, origins: state.origins || [] });
  console.log(`Uploading ${state.cookies.length} cookies (${threadsCookies.length} Threads/Instagram-related) to VPS...`);

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-upload-token': TOKEN,
    },
    body: payload,
  });

  const text = await res.text();
  if (!res.ok) {
    console.error('Upload failed:', res.status, text);
    await context.close();
    process.exit(1);
  }

  console.log('VPS response:');
  console.log(text);
  console.log('\nDone. Cookies saved on VPS. You can close the browser.');
  await context.close();
})();
'''


def write_private_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    os.chmod(path, 0o600)


def build_handler(token: str, account: str, public_base: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ThreadsCookieReceiver/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

        def _send(self, status: int, body: str, content_type: str = "text/plain; charset=utf-8") -> None:
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._send(200, "ok\n")
                return
            if parsed.path == "/windows-login.js":
                qs = parse_qs(parsed.query)
                if (qs.get("token") or [""])[0] != token:
                    self._send(403, "bad token\n")
                    return
                upload_url = f"{public_base.rstrip('/')}/upload"
                script = NODE_TEMPLATE.replace("__UPLOAD_URL__", upload_url).replace("__TOKEN__", token)
                self._send(200, script, "application/javascript; charset=utf-8")
                return
            self._send(404, "not found\n")

        def do_POST(self) -> None:
            if self.path != "/upload":
                self._send(404, "not found\n")
                return
            if self.headers.get("x-upload-token") != token:
                self._send(403, "bad token\n")
                return
            length = int(self.headers.get("content-length") or "0")
            if length <= 0 or length > 5_000_000:
                self._send(400, "bad length\n")
                return
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
            except Exception as exc:
                self._send(400, f"invalid json: {exc}\n")
                return
            cookies = payload.get("cookies") if isinstance(payload, dict) else None
            if not isinstance(cookies, list) or not cookies:
                self._send(400, "payload must be Playwright storageState with cookies[]\n")
                return
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            upload_path = STATE_DIR / f"uploaded-{account}-{int(time.time())}.json"
            write_private_json(upload_path, payload)
            cmd = [sys.executable, str(STORE_SCRIPT), str(upload_path), "--account", account]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                result = json.loads(proc.stdout[proc.stdout.find('{'):]) if '{' in proc.stdout else {"raw": proc.stdout}
            except Exception:
                result = {"raw": proc.stdout}
            result["receiverStoredUpload"] = str(upload_path)
            result["timestamp"] = time.strftime("%Y-%m-%d %H:%M:%S %z")
            write_private_json(LAST_UPLOAD, result)
            if proc.returncode != 0:
                self._send(500, json.dumps({"ok": False, "error": "store script failed", "result": result}, indent=2) + "\n", "application/json")
                return
            safe = {
                "ok": True,
                "account": account,
                "cookieCount": result.get("cookieCount"),
                "domainCounts": result.get("domainCounts"),
                "storageStatePath": result.get("storageStatePath"),
                "message": "Cookies saved on VPS. Do not share this browser profile/cookie file.",
            }
            self._send(200, json.dumps(safe, indent=2, ensure_ascii=False) + "\n", "application/json")
    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="Threads one-time cookie receiver")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--account", default="threads-2")
    parser.add_argument("--public-base", default="http://100.68.77.125:8765")
    parser.add_argument("--token", default="")
    args = parser.parse_args()
    token = args.token or secrets.token_urlsafe(24)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
    os.chmod(TOKEN_FILE, 0o600)
    print(json.dumps({
        "ok": True,
        "host": args.host,
        "port": args.port,
        "account": args.account,
        "scriptUrl": f"{args.public_base.rstrip()}/windows-login.js?token={token}",
        "healthUrl": f"{args.public_base.rstrip()}/health",
    }, indent=2))
    sys.stdout.flush()
    httpd = ThreadingHTTPServer((args.host, args.port), build_handler(token, args.account, args.public_base))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
