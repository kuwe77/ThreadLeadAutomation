#!/usr/bin/env python3
"""Store a browser cookie export as a Threads Playwright storage-state file.

Accepts common formats:
- Playwright storage state: {"cookies": [...], "origins": [...]}
- Cookie-Editor/Chrome extension export: [{...cookie...}, ...]

Writes a Playwright-compatible storage-state file, then runs import_cookies.py
so Lightpanda cookie jars are generated too. Never prints cookie values.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List

ROOT = Path(__file__).resolve().parents[1]
IMPORT_SCRIPT = ROOT / "scripts" / "import_cookies.py"
DEFAULT_CONFIG = ROOT / "finder_config.json"
DASHBOARD_AUTH_DIR = Path("/root/.hermes/dashboard/state/auth")


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


def same_site(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("_", "-")
    if raw in {"strict"}:
        return "Strict"
    if raw in {"lax"}:
        return "Lax"
    # Cookie-Editor often uses no_restriction/no-restriction/unspecified.
    return "None"


def expires(value: Any, fallback: Any = None) -> float:
    raw = value if value is not None else fallback
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return -1
    if val <= 0:
        return -1
    return val


def normalize_cookie(cookie: Dict[str, Any]) -> Dict[str, Any] | None:
    name = str(cookie.get("name") or "").strip()
    domain = str(cookie.get("domain") or cookie.get("host") or "").strip()
    if not name or not domain:
        return None
    return {
        "name": name,
        "value": str(cookie.get("value") or ""),
        "domain": domain,
        "path": str(cookie.get("path") or "/"),
        "expires": expires(cookie.get("expires"), cookie.get("expirationDate")),
        "httpOnly": bool(cookie.get("httpOnly") or cookie.get("http_only")),
        "secure": bool(cookie.get("secure")),
        "sameSite": same_site(cookie.get("sameSite") or cookie.get("same_site")),
    }


def extract_cookies(raw: Any) -> List[Dict[str, Any]]:
    if isinstance(raw, dict):
        source = raw.get("cookies") or []
    elif isinstance(raw, list):
        source = raw
    else:
        source = []
    out: List[Dict[str, Any]] = []
    for item in source:
        if not isinstance(item, dict):
            continue
        norm = normalize_cookie(item)
        if norm:
            out.append(norm)
    return out


def domain_counts(cookies: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for cookie in cookies:
        domain = str(cookie.get("domain") or "[no-domain]")
        counts[domain] = counts.get(domain, 0) + 1
    return dict(sorted(counts.items()))


def main() -> int:
    parser = argparse.ArgumentParser(description="Store uploaded Threads cookies for an account")
    parser.add_argument("cookie_json", help="Path to uploaded cookie JSON")
    parser.add_argument("--account", default="threads-2", help="Account id in finder_config.json")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--output", help="Storage-state output path; defaults from account.storageStatePath")
    args = parser.parse_args()

    raw_path = Path(args.cookie_json).expanduser().resolve()
    config_path = Path(args.config).expanduser().resolve()
    config = load_json(config_path)
    account = next((a for a in config.get("accounts", []) if a.get("id") == args.account), None)
    if not account:
        raise SystemExit(f"account not found: {args.account}")

    raw = load_json(raw_path)
    cookies = extract_cookies(raw)
    if not cookies:
        raise SystemExit("no usable cookies found in uploaded JSON")

    output = Path(args.output or account.get("storageStatePath") or (DASHBOARD_AUTH_DIR / f"cms-{args.account}.json")).expanduser()
    storage_state = {"cookies": cookies, "origins": []}
    write_private_json(output, storage_state)

    import_result = subprocess.run(
        [sys.executable, str(IMPORT_SCRIPT), "--config", str(config_path), "--account", args.account],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    print(json.dumps({
        "ok": import_result.returncode == 0,
        "account": args.account,
        "storageStatePath": str(output),
        "cookieCount": len(cookies),
        "domainCounts": domain_counts(cookies),
        "importExitCode": import_result.returncode,
    }, indent=2, ensure_ascii=False))
    if import_result.returncode != 0:
        print(import_result.stdout, file=sys.stderr)
    return import_result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
