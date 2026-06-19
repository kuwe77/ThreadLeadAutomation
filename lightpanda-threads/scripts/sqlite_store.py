#!/usr/bin/env python3
"""SQLite persistence for the Lightpanda Threads finder.

The original Zakwa WSL feature was JSON/JSONL-backed. This module keeps those
files as compatibility mirrors for the existing dashboard while making SQLite
the structured local store on this VPS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = ROOT / "state"
DB_PATH = STATE_DIR / "lightpanda_threads.db"
DASHBOARD_ACTION_STATE_DIR = Path("/root/.hermes/dashboard/state/threads-recent-topic-flow")
CONFIG_PATH = ROOT / "finder_config.json"
SEEN_PATH = STATE_DIR / "seen-posts.json"
HISTORY_PATH = STATE_DIR / "runs.jsonl"
STATUS_PATH = STATE_DIR / "status.json"
LAST_SUMMARY_PATH = STATE_DIR / "cron-last-summary.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def loads_file(path: Path, fallback: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return fallback


def normalize_post_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        if not parsed.scheme and raw.startswith("www."):
            parsed = urlparse("https://" + raw)
        path = parsed.path.rstrip("/") or parsed.path
        return urlunparse((parsed.scheme or "https", parsed.netloc.lower(), path, "", "", ""))
    except Exception:
        return raw.split("?", 1)[0].rstrip("/")


def post_key(url: str) -> str:
    norm = normalize_post_url(url)
    if not norm:
        return ""
    return hashlib.sha1(norm.encode("utf-8", "ignore")).hexdigest()[:24]


def candidate_id(run_id: str, account_id: str, candidate: Dict[str, Any]) -> str:
    base = "|".join([
        str(run_id or ""),
        str(account_id or ""),
        normalize_post_url(str(candidate.get("url") or "")),
        str(candidate.get("keyword") or ""),
    ])
    return hashlib.sha1(base.encode("utf-8", "ignore")).hexdigest()[:32]


def connect(db_path: Path | str = DB_PATH) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    init_db(conn)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          label TEXT,
          handle TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          intent_mode TEXT,
          buyer_intent_only INTEGER,
          buyer_intent_min_confidence REAL,
          storage_state_path TEXT,
          base_cookies_path TEXT,
          session_cookies_path TEXT,
          keywords_json TEXT,
          reply_draft_template TEXT,
          raw_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          browser_source TEXT,
          mode TEXT,
          started_at TEXT,
          finished_at TEXT,
          account_count INTEGER,
          candidate_count INTEGER,
          checked_post_count INTEGER,
          run_dir TEXT,
          resource_json TEXT,
          safety_json TEXT,
          raw_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_accounts (
          run_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          account_label TEXT,
          intent_mode TEXT,
          exit_code INTEGER,
          candidate_count INTEGER,
          checked_post_count INTEGER,
          resource_json TEXT,
          errors_json TEXT,
          run_dir TEXT,
          raw_json TEXT NOT NULL,
          PRIMARY KEY (run_id, account_id)
        );

        CREATE TABLE IF NOT EXISTS candidates (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          account_id TEXT,
          account_label TEXT,
          url TEXT,
          post_key TEXT,
          keyword TEXT,
          handle TEXT,
          score REAL,
          language TEXT,
          intent TEXT,
          confidence REAL,
          text TEXT,
          telegram_json TEXT,
          action_id TEXT,
          raw_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS seen_posts (
          post_key TEXT PRIMARY KEY,
          url TEXT,
          source TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          raw_json TEXT
        );

        CREATE TABLE IF NOT EXISTS telegram_actions (
          id TEXT PRIMARY KEY,
          short_id TEXT,
          status TEXT,
          post_url TEXT,
          post_key TEXT,
          chat_id TEXT,
          thread_id INTEGER,
          account_id TEXT,
          account_label TEXT,
          browser_source TEXT,
          preview_message_ids_json TEXT,
          raw_json TEXT NOT NULL,
          created_at TEXT,
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS cron_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS event_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL,
          event TEXT NOT NULL,
          message TEXT,
          payload_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_candidates_post_key ON candidates(post_key);
        CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id, account_id);
        CREATE INDEX IF NOT EXISTS idx_telegram_actions_post_key ON telegram_actions(post_key);
        """
    )
    conn.commit()


def record_config(config: Dict[str, Any], db_path: Path | str = DB_PATH) -> None:
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)",
            ("finder_config", dumps(config), ts),
        )
        for account in config.get("accounts") or []:
            if not isinstance(account, dict):
                continue
            conn.execute(
                """
                INSERT OR REPLACE INTO accounts(
                  id, label, handle, enabled, intent_mode, buyer_intent_only,
                  buyer_intent_min_confidence, storage_state_path, base_cookies_path,
                  session_cookies_path, keywords_json, reply_draft_template, raw_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(account.get("id") or ""),
                    str(account.get("label") or ""),
                    str(account.get("handle") or ""),
                    0 if account.get("enabled") is False else 1,
                    str(account.get("intentMode") or ""),
                    0 if account.get("buyerIntentOnly") is False else 1,
                    float(account.get("buyerIntentMinConfidence") or config.get("buyerIntentMinConfidence") or 0),
                    str(account.get("storageStatePath") or ""),
                    str(account.get("baseCookiesPath") or account.get("cookiesPath") or ""),
                    str(account.get("sessionCookiesPath") or ""),
                    dumps(account.get("keywords") or []),
                    str(account.get("replyDraftTemplate") or ""),
                    dumps(account),
                    ts,
                ),
            )
        conn.commit()


def record_seen(url: str, source: str = "unknown", raw: Any = None, conn: Optional[sqlite3.Connection] = None) -> None:
    key = post_key(url)
    if not key:
        return
    ts = now_iso()
    own = conn is None
    if own:
        conn = connect(DB_PATH)
    assert conn is not None
    conn.execute(
        """
        INSERT INTO seen_posts(post_key, url, source, first_seen_at, last_seen_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(post_key) DO UPDATE SET
          url=COALESCE(excluded.url, seen_posts.url),
          source=excluded.source,
          last_seen_at=excluded.last_seen_at,
          raw_json=COALESCE(excluded.raw_json, seen_posts.raw_json)
        """,
        (key, normalize_post_url(url), source, ts, ts, dumps(raw) if raw is not None else None),
    )
    if own:
        conn.commit(); conn.close()


def record_action_state(state: Dict[str, Any], db_path: Path | str = DB_PATH) -> None:
    if not isinstance(state, dict) or not state.get("id"):
        return
    post = state.get("post") or {}
    browser = state.get("browser") or {}
    telegram = state.get("telegram") or {}
    url = str(post.get("url") or "")
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO telegram_actions(
              id, short_id, status, post_url, post_key, chat_id, thread_id,
              account_id, account_label, browser_source, preview_message_ids_json,
              raw_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(state.get("id") or ""),
                str(state.get("shortId") or ""),
                str(state.get("status") or ""),
                normalize_post_url(url),
                post_key(url),
                str(telegram.get("chatId") or ""),
                int(telegram.get("threadId")) if telegram.get("threadId") not in (None, "") else None,
                str(browser.get("accountId") or ""),
                str(browser.get("accountLabel") or ""),
                str(browser.get("source") or ""),
                dumps(state.get("previewMessageIds") or []),
                dumps(state),
                str(state.get("createdAt") or now_iso()),
                str(state.get("updatedAt") or now_iso()),
            ),
        )
        record_seen(url, "telegram_action", state, conn)
        conn.commit()


def record_run_summary(summary: Dict[str, Any], db_path: Path | str = DB_PATH) -> None:
    if not isinstance(summary, dict):
        return
    run_id = str(summary.get("runId") or "")
    if not run_id:
        return
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO runs(
              run_id, browser_source, mode, started_at, finished_at,
              account_count, candidate_count, checked_post_count, run_dir,
              resource_json, safety_json, raw_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                str(summary.get("browserSource") or ""),
                str(summary.get("mode") or ""),
                str(summary.get("startedAt") or ""),
                str(summary.get("finishedAt") or ""),
                int(summary.get("accountCount") or 0),
                int(summary.get("candidateCount") or 0),
                int(summary.get("checkedPostCount") or 0),
                str(summary.get("runDir") or ""),
                dumps(summary.get("resource") or {}),
                dumps(summary.get("safety") or {}),
                dumps(summary),
                ts,
            ),
        )
        for result in summary.get("results") or []:
            if not isinstance(result, dict):
                continue
            account_id = str(result.get("accountId") or result.get("account") or "")
            conn.execute(
                """
                INSERT OR REPLACE INTO run_accounts(
                  run_id, account_id, account_label, intent_mode, exit_code,
                  candidate_count, checked_post_count, resource_json, errors_json, run_dir, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    account_id,
                    str(result.get("accountLabel") or ""),
                    str(result.get("intentMode") or ""),
                    int(result.get("exitCode") or 0),
                    int(result.get("candidateCount") or 0),
                    int(result.get("checkedPostCount") or 0),
                    dumps(result.get("resource") or {}),
                    dumps(result.get("errors") or []),
                    str(result.get("runDir") or ""),
                    dumps(result),
                ),
            )
            for cand in result.get("candidates") or []:
                if not isinstance(cand, dict):
                    continue
                url = str(cand.get("url") or "")
                buyer = cand.get("buyerIntent") or {}
                lang = cand.get("languageDecision") or {}
                action = cand.get("telegramAction") or cand.get("actionState") or {}
                cid = candidate_id(run_id, account_id, cand)
                conn.execute(
                    """
                    INSERT OR REPLACE INTO candidates(
                      id, run_id, account_id, account_label, url, post_key, keyword,
                      handle, score, language, intent, confidence, text, telegram_json,
                      action_id, raw_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        cid,
                        run_id,
                        account_id,
                        str(result.get("accountLabel") or ""),
                        normalize_post_url(url),
                        post_key(url),
                        str(cand.get("keyword") or ""),
                        str(cand.get("handle") or ""),
                        float(cand.get("score") or 0),
                        str(lang.get("language") or cand.get("language") or ""),
                        str(buyer.get("intent") or cand.get("intent") or ""),
                        float(buyer.get("confidence") or lang.get("confidence") or cand.get("confidence") or 0),
                        str(cand.get("text") or cand.get("description") or cand.get("title") or ""),
                        dumps(cand.get("telegram") or cand.get("telegramResult") or {}),
                        str(action.get("id") or cand.get("actionId") or ""),
                        dumps(cand),
                        ts,
                    ),
                )
                record_seen(url, "candidate", cand, conn)
        conn.commit()


def migrate_json(config_path: Path = CONFIG_PATH, db_path: Path | str = DB_PATH) -> Dict[str, Any]:
    stats = {"config": False, "runs": 0, "actions": 0, "seen": 0, "db": str(db_path)}
    config = loads_file(config_path, {}) or {}
    if config:
        record_config(config, db_path)
        stats["config"] = True
    seen_data = loads_file(SEEN_PATH, {}) or {}
    with connect(db_path) as conn:
        seen_items = seen_data.get("seen") if isinstance(seen_data, dict) else seen_data
        for item in seen_items or []:
            url = item.get("url") if isinstance(item, dict) else str(item)
            record_seen(str(url or item or ""), "seen_json", item, conn)
            stats["seen"] += 1
        conn.commit()
    for path in [HISTORY_PATH]:
        if path.exists():
            for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    record_run_summary(json.loads(raw), db_path)
                    stats["runs"] += 1
                except Exception:
                    pass
    for path in [STATUS_PATH, LAST_SUMMARY_PATH]:
        data = loads_file(path, None)
        if isinstance(data, dict) and data.get("runId"):
            record_run_summary(data, db_path)
            stats["runs"] += 1
    if DASHBOARD_ACTION_STATE_DIR.exists():
        for path in DASHBOARD_ACTION_STATE_DIR.glob("thrrec_*.json"):
            data = loads_file(path, None)
            if isinstance(data, dict):
                record_action_state(data, db_path)
                stats["actions"] += 1
    return stats


def get_stats(db_path: Path | str = DB_PATH) -> Dict[str, Any]:
    out: Dict[str, Any] = {"db": str(db_path)}
    with connect(db_path) as conn:
        for table in ["accounts", "runs", "run_accounts", "candidates", "seen_posts", "telegram_actions"]:
            out[table] = conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
        row = conn.execute("SELECT raw_json FROM runs ORDER BY finished_at DESC, created_at DESC LIMIT 1").fetchone()
        out["latestRun"] = json.loads(row["raw_json"]) if row else None
    return out


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Lightpanda Threads SQLite store")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("migrate")
    sub.add_parser("stats")
    rec = sub.add_parser("record-run-summary")
    rec.add_argument("path")
    act = sub.add_parser("record-action-state")
    act.add_argument("path")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.cmd == "init":
        connect(DB_PATH).close()
        print(json.dumps({"ok": True, "db": str(DB_PATH)}, indent=2))
        return 0
    if args.cmd == "migrate":
        print(json.dumps(migrate_json(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "stats":
        print(json.dumps(get_stats(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "record-run-summary":
        record_run_summary(loads_file(Path(args.path), {}))
        print(json.dumps({"ok": True}, indent=2))
        return 0
    if args.cmd == "record-action-state":
        record_action_state(loads_file(Path(args.path), {}))
        print(json.dumps({"ok": True}, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
