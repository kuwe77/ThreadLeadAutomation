#!/usr/bin/env python3
"""Hermes cron wrapper for the standalone Lightpanda Threads finder.

Quiet on success: candidate Telegram messages are sent by the finder itself with
Source: PandaBrowser/Lightpanda. Cron stdout is reserved for errors only so the
hourly job does not spam duplicate summaries.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/root/.hermes/lightpanda-threads")
SCRIPT = ROOT / "scripts" / "lightpanda_threads_finder.py"
CONFIG = ROOT / "finder_config.json"
STATE = ROOT / "state"
LAST_STDOUT = STATE / "cron-last-stdout.json"
LAST_ERROR = STATE / "cron-last-error.txt"
LAST_SUMMARY = STATE / "cron-last-summary.json"
LOCK = STATE / "lightpanda-cron.lock"
SOURCE = "PandaBrowser/Lightpanda"


def main() -> int:
    STATE.mkdir(parents=True, exist_ok=True)
    if LOCK.exists():
        try:
            pid = int(LOCK.read_text().strip())
            os.kill(pid, 0)
            print(f"⚠️ Lightpanda Threads cron skipped: previous run still active.\nSource: {SOURCE}\nPID: {pid}")
            return 0
        except Exception:
            LOCK.unlink(missing_ok=True)
    LOCK.write_text(str(os.getpid()))
    try:
        cmd = [sys.executable, str(SCRIPT), "--config", str(CONFIG), "--all"]
        max_keywords = os.environ.get("LIGHTPANDA_MAX_KEYWORDS")
        max_candidates = os.environ.get("LIGHTPANDA_MAX_CANDIDATES")
        if max_keywords:
            cmd += ["--max-keywords", max_keywords]
        if max_candidates:
            cmd += ["--max-candidates", max_candidates]
        if os.environ.get("LIGHTPANDA_NO_SEND") in {"1", "true", "TRUE", "yes"}:
            cmd.append("--no-send")
        started = time.time()
        proc = subprocess.run(cmd, cwd=str(ROOT), text=True, capture_output=True, timeout=50 * 60)
        duration = round(time.time() - started, 2)
        if proc.stdout.strip():
            LAST_STDOUT.write_text(proc.stdout, encoding="utf-8")
        if proc.stderr.strip():
            LAST_ERROR.write_text(proc.stderr, encoding="utf-8")
        if proc.returncode != 0:
            print(f"❌ Lightpanda Threads cron failed\nSource: {SOURCE}\nExit: {proc.returncode}\n{(proc.stderr or proc.stdout)[-1800:]}")
            return proc.returncode
        try:
            summary = json.loads(proc.stdout)
        except Exception:
            summary = {"raw": proc.stdout[-4000:]}
        compact = {
            "browserSource": SOURCE,
            "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S %z"),
            "durationSeconds": duration,
            "candidateCount": summary.get("candidateCount"),
            "checkedPostCount": summary.get("checkedPostCount"),
            "accountCount": summary.get("accountCount"),
            "runDir": summary.get("runDir"),
        }
        LAST_SUMMARY.write_text(json.dumps(compact, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        # Quiet success. Candidate messages already include Source: PandaBrowser/Lightpanda.
        return 0
    except subprocess.TimeoutExpired as exc:
        print(f"❌ Lightpanda Threads cron timed out\nSource: {SOURCE}\nTimeout: {exc.timeout}s")
        return 124
    except Exception as exc:
        print(f"❌ Lightpanda Threads cron crashed\nSource: {SOURCE}\n{type(exc).__name__}: {exc}")
        return 1
    finally:
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
