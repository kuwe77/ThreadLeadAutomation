#!/usr/bin/env python3
"""Import Playwright storage-state cookies into Lightpanda cookie JSON.

Reads existing Threads storage-state files read-only and writes separate
Lightpanda-compatible cookie arrays under ~/.hermes/lightpanda-threads/state/.
Never prints cookie values.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.json"
STATE_DIR = ROOT / "state"
COOKIES_DIR = STATE_DIR / "cookies"
REPORT_PATH = STATE_DIR / "import-report.json"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_private_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    os.chmod(path, 0o600)


def normalize_expires(value: Any) -> float | None:
    # Playwright uses -1 for session cookies. Lightpanda treats negative expires
    # as expired, so convert it to null/session cookie.
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if numeric < 0:
        return None
    return numeric


def convert_cookie(cookie: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": str(cookie.get("name", "")),
        "value": str(cookie.get("value", "")),
        "domain": str(cookie.get("domain", "")),
        "path": str(cookie.get("path") or "/"),
        "expires": normalize_expires(cookie.get("expires")),
        "secure": bool(cookie.get("secure", False)),
        "httpOnly": bool(cookie.get("httpOnly", False)),
        "sameSite": cookie.get("sameSite") or "None",
    }


def safe_domain_counts(cookies: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for cookie in cookies:
        domain = str(cookie.get("domain") or "[no-domain]")
        counts[domain] = counts.get(domain, 0) + 1
    return dict(sorted(counts.items()))


def import_account(account: Dict[str, Any]) -> Dict[str, Any]:
    source = Path(account["storageStatePath"]).expanduser()
    # Older spike config used cookiesPath; the full finder config uses
    # baseCookiesPath so runtime/session cookie jars stay separate.
    target_value = account.get("cookiesPath") or account.get("baseCookiesPath")
    if not target_value:
        raise KeyError("cookiesPath/baseCookiesPath")
    target = Path(target_value)
    if not target.is_absolute():
        target = ROOT / target

    report: Dict[str, Any] = {
        "id": account.get("id"),
        "label": account.get("label"),
        "source": str(source),
        "target": str(target),
        "ok": False,
        "cookieCount": 0,
        "domainCounts": {},
    }

    if not source.exists():
        report["error"] = "storage-state file not found"
        return report

    raw = load_json(source)
    if isinstance(raw, dict):
        raw_cookies = raw.get("cookies", [])
    elif isinstance(raw, list):
        # Browser extensions such as Cookie-Editor commonly export a raw cookie array.
        raw_cookies = raw
    else:
        raw_cookies = []
    converted = [convert_cookie(c) for c in raw_cookies if isinstance(c, dict) and c.get("name") and c.get("domain")]
    write_private_json(target, converted)

    stat = source.stat()
    report.update(
        {
            "ok": True,
            "cookieCount": len(converted),
            "domainCounts": safe_domain_counts(converted),
            "sourceMtime": stat.st_mtime,
            "sourceMtimeLocal": time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(stat.st_mtime)),
            "targetMode": oct(target.stat().st_mode & 0o777),
        }
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Import Threads cookies for Lightpanda")
    parser.add_argument("--config", default=str(CONFIG_PATH))
    parser.add_argument("--account", help="Only import one account id")
    args = parser.parse_args()

    config_path = Path(args.config).expanduser()
    config = load_json(config_path)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    COOKIES_DIR.mkdir(parents=True, exist_ok=True)

    reports: List[Dict[str, Any]] = []
    for account in config.get("accounts", []):
        if args.account and account.get("id") != args.account:
            continue
        # If an explicit account is requested, import it even when disabled.
        # Disabled only means cron/search is off; login/cookie setup must still work.
        if not args.account and not account.get("enabled", True):
            continue
        reports.append(import_account(account))

    existing_accounts: List[Dict[str, Any]] = []
    if args.account and REPORT_PATH.exists():
        try:
            existing_payload = load_json(REPORT_PATH)
            existing_accounts = list(existing_payload.get("accounts", [])) if isinstance(existing_payload, dict) else []
        except Exception:
            existing_accounts = []

    by_id: Dict[str, Dict[str, Any]] = {str(item.get("id")): item for item in existing_accounts if item.get("id")}
    for report in reports:
        by_id[str(report.get("id"))] = report

    merged_reports = list(by_id.values()) if args.account else reports
    payload = {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "config": str(config_path),
        "accounts": merged_reports,
    }
    write_private_json(REPORT_PATH, payload)
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0 if all(item.get("ok") for item in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
