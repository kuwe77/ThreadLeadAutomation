#!/usr/bin/env python3
"""Standalone Lightpanda Threads finder.

Runs completely outside the live Next dashboard, existing Node.js scripts, and
Patchright runner. It imports the same Threads storage-state cookies read-only,
uses Lightpanda CDP to search Threads, sends Telegram candidate notifications
with an explicit browser source label, and writes monitor status JSON.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import signal
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import quote_plus, unquote, urlparse, urlunparse

import requests
import websockets

ROOT = Path(__file__).resolve().parents[1]
HERMES_HOME = str(ROOT.parent)
CONFIG_PATH = ROOT / "finder_config.json"
STATE_DIR = ROOT / "state"
RUNS_DIR = STATE_DIR / "finder-runs"
STATUS_PATH = STATE_DIR / "status.json"
HISTORY_PATH = STATE_DIR / "runs.jsonl"
SEEN_PATH = STATE_DIR / "seen-posts.json"
KEYWORD_ROTATION_PATH = STATE_DIR / "keyword-rotation.json"
IMPORT_SCRIPT = ROOT / "scripts" / "import_cookies.py"
DEFAULT_THREADS_ACTION_STATE_DIR = Path("/root/.hermes/dashboard/state/threads-recent-topic-flow")
DASHBOARD_ROOT = DEFAULT_THREADS_ACTION_STATE_DIR.parents[1]
THREADS_RECENT_FLOW_SCRIPT = DASHBOARD_ROOT / "scripts" / "threads-recent-topic-flow.js"
SQLITE_DB_PATH = STATE_DIR / "lightpanda_threads.db"
HZ = os.sysconf(os.sysconf_names["SC_CLK_TCK"])

try:
    from sqlite_store import record_action_state as sqlite_record_action_state
    from sqlite_store import record_config as sqlite_record_config
    from sqlite_store import record_run_summary as sqlite_record_run_summary
except Exception:  # SQLite persistence must never break lead collection.
    sqlite_record_action_state = None
    sqlite_record_config = None
    sqlite_record_run_summary = None

PROPERTY_INTENT = [
    "cari rumah", "nak beli rumah", "nak sewa", "rumah sewa", "looking for house",
    "looking to buy", "looking to rent", "want to buy", "want to rent", "need house",
    "need property", "mencari rumah", "budget rumah", "ada rumah sewa", "wtb",
]
AUTOMATION_INTENT = [
    "looking for", "looking to", "need someone", "need help", "need a", "nak belajar", "nak buat",
    "nak automate", "mencari", "cari orang", "technical partner", "partner", "help me",
    "boleh bantu", "recommend", "kelas", "belajar", "course", "tutorial", "dm me", "malaysia preferred",
]
INDONESIAN_CUES = [
    "indonesia", "jakarta", "bandung", "surabaya", "jogja", "yogyakarta", "bali", "bekasi", "depok", "tangerang", "malang",
    "gue", "gua", "gw", "loe", "lo", "lu", "elu", "nggak", "ngga", "gak", "ga", "kagak", "udah", "aja", "dong", "nih", "sih", "deh", "banget",
    "butuh", "dibutuhin", "disediain", "bikin", "pakai", "pake", "jualan", "bisnis", "kampanye", "toko", "referensi", "pemula",
    "otomatisasi", "pelanggan", "semuanya", "buat pengguna", "orang yang", "seseorang yang",
    # Common Indonesian phrasing seen in n8n/automation searches. Keep these as
    # phrases/cues rather than broad language labels so Malaysian Malay leads are
    # not rejected just because they use shared words like "belajar".
    "warga threads", "baiknya", "mulai", "darimana", "dimulai", "ijin tanya", "izin tanya", "ndak", "mudeng", "keren pak",
    "karena", "karna", "pengen", "kepake", "mutusin", "belakangan", "iseng", "ngerti", "kartu kredit", "kartu", "solusinya", "triger", "belajar bareng", "area malang",
]
INDONESIAN_REGEXES = [
    r"\brp\s*\d[\d.,]*(?:\s*(?:juta|rb|ribu|k))?\b",
    r"\b(?:gue|gua|gw|loe|lo|lu|elu)\b",
    r"\b(?:nggak|ngga|gak|ga|kagak|udah|aja|dong|nih|sih|deh|banget)\b",
    r"\b(?:jakarta|bandung|surabaya|jogja|yogyakarta|bekasi|depok|tangerang|semarang|medan|makassar|bali|malang)\b",
    r"\b(?:butuh|dibutuhin|disediain|bikin|pake|pakai|jualan|bisnis|kampanye|toko|otomatisasi|pelanggan)\b",
    r"\b(?:warga\s+threads|baiknya|mulai|dari\s+mana|darimana|dimulai|i[szj]in\s+tanya|ndak|mudeng|keren\s+pak)\b",
    r"\b(?:karena|karna|pengen|kepake|mutusin|belakangan|iseng|ngerti|kartu\s+kredit|kartu|solusinya|triger|belajar\s+bareng|area\s+malang)\b",
]
MALAYSIA_CUES = [
    "malaysia", "kuala lumpur", "selangor", "penang", "pulau pinang", "johor", "melaka", "perak", "kedah", "kelantan", "terengganu",
    "sabah", "sarawak", "putrajaya", "cyberjaya", "shah alam", "petaling jaya", "subang", "puchong", "kajang", "rawang", "nilai", "seremban",
]
NOISE_TERMS = [
    "quiz", "which statement", "apa jawapan", "meme", "giveaway", "promo code", "discount code",
]
NAV_NOISE = [
    "Home", "New thread", "Search", "Messages", "Activity", "Profile", "Insights", "Saved",
    "Feeds", "More", "Thread", "Top", "View activity", "© 2026", "Threads Terms", "Privacy Policy", "Cookies Policy",
]


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, payload: Any, private: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if private:
        os.chmod(tmp, 0o600)
    tmp.replace(path)
    if private:
        os.chmod(path, 0o600)


def append_jsonl(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def safe_path(path: str) -> Path:
    p = Path(path).expanduser()
    return p if p.is_absolute() else ROOT / p


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def normalize_post_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    host = (parsed.netloc or "www.threads.net").lower()
    if host.startswith("www."):
        host = host[4:]
    if host not in {"threads.com", "threads.net"}:
        return ""
    path = parsed.path.replace("//", "/")
    if path.endswith("/media"):
        path = path[:-6]
    if not re.match(r"^/(?:@[^/]+/post/[^/?#]+|t/[^/?#]+)$", path.rstrip("/"), re.I):
        return ""
    return urlunparse(("https", "www.threads.com", path.rstrip("/"), "", "", ""))


def post_key(url: str) -> str:
    normalized = normalize_post_url(url)
    return normalized.replace("https://www.threads.com", "https://www.threads.net") if normalized else ""


def build_search_url(base_url: str, keyword: str) -> str:
    return f"{base_url.rstrip('/')}/search?q={quote_plus(keyword)}&serp_type=default"


def truncate(text: str, limit: int = 900) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def clean_post_text(text: str) -> str:
    out = str(text or "").replace("\u00a0", " ")
    for token in NAV_NOISE:
        out = out.replace(token, " ")
    out = re.sub(r"\s+", " ", out).strip()
    return out


def keyword_list(account: Dict[str, Any], limit: int) -> List[str]:
    kws = [str(k).strip() for k in account.get("keywords") or [] if str(k).strip()]
    return kws[:limit] if limit > 0 else kws


def rotating_keyword_list(account: Dict[str, Any], limit: int, *, advance: bool = True) -> Tuple[List[str], Dict[str, Any]]:
    """Return up to limit keywords, rotating through the full account list per real run.

    `maxKeywordsPerAccount` should mean "keywords per run", not "first N keywords
    forever". Rotation state is stored per account so cron run 1 can use keywords
    1-6, run 2 uses 7-12, then wraps around.
    """
    kws = [str(k).strip() for k in account.get("keywords") or [] if str(k).strip()]
    account_id = str(account.get("id") or account.get("label") or account.get("handle") or "default")
    if not kws:
        return [], {"accountId": account_id, "startIndex": 0, "nextIndex": 0, "totalKeywords": 0, "limit": limit}
    if limit <= 0 or limit >= len(kws):
        selected = kws[:]
        start = 0
        next_index = 0
    else:
        state = load_json(KEYWORD_ROTATION_PATH, {"accounts": {}})
        account_state = (state.get("accounts") or {}).get(account_id) or {}
        try:
            start = int(account_state.get("nextIndex") or 0) % len(kws)
        except Exception:
            start = 0
        selected = [kws[(start + offset) % len(kws)] for offset in range(limit)]
        next_index = (start + limit) % len(kws)
    meta = {
        "accountId": account_id,
        "startIndex": start,
        "nextIndex": next_index,
        "totalKeywords": len(kws),
        "limit": limit,
        "selected": selected,
    }
    if advance and kws:
        state = load_json(KEYWORD_ROTATION_PATH, {"accounts": {}})
        accounts = state.get("accounts") if isinstance(state.get("accounts"), dict) else {}
        accounts[account_id] = {
            "nextIndex": next_index,
            "totalKeywords": len(kws),
            "lastSelected": selected,
            "lastStartIndex": start,
            "updatedAt": iso_timestamp(),
        }
        state["accounts"] = accounts
        state["updatedAt"] = iso_timestamp()
        write_json(KEYWORD_ROTATION_PATH, state)
    return selected, meta


def effective_auto_comment(config: Dict[str, Any], account: Dict[str, Any]) -> Dict[str, bool]:
    global_auto = config.get("autoComment") or {}
    enabled = account.get("autoCommentEnabled")
    submit = account.get("commentSubmitEnabled")
    return {
        "enabled": bool(global_auto.get("enabled") if enabled is None else enabled),
        "submit": bool(global_auto.get("submit") if submit is None else submit),
    }


def detect_indonesian_like(text: str) -> Tuple[bool, List[str]]:
    """Detect Indonesian-looking posts from the already extracted full post text."""
    normalized = " " + re.sub(r"\s+", " ", str(text or "").lower()).strip() + " "
    if not normalized.strip():
        return False, []
    malaysia_hits = [cue for cue in MALAYSIA_CUES if cue in normalized]
    regex_hits_out: List[str] = []
    for pattern in INDONESIAN_REGEXES:
        match = re.search(pattern, normalized, re.I | re.S)
        if match:
            regex_hits_out.append(truncate(match.group(0), 60))
    cue_hits = [cue for cue in INDONESIAN_CUES if re.search(rf"(?<![a-z0-9_]){re.escape(cue)}(?![a-z0-9_])", normalized, re.I)]
    hits = list(dict.fromkeys(regex_hits_out + cue_hits))
    if not hits:
        return False, []
    strong_geo_or_currency = bool(re.search(r"\b(?:indonesia|jakarta|bandung|surabaya|jogja|yogyakarta|bekasi|depok|tangerang|semarang|medan|makassar|bali|malang)\b|\brp\s*\d", normalized, re.I))
    strong_language = bool(re.search(r"\b(?:gue|gua|gw|loe|lo|lu|elu|nggak|ngga|gak|ga|kagak|udah|butuh|dibutuhin|disediain|bikin|pake|jualan|bisnis|otomatisasi|pelanggan|karena|karna|pengen|kepake|mutusin|belakangan|iseng|ngerti|kartu|solusinya|triger|ndak|mudeng)\b", normalized, re.I))
    # If the post clearly says Malaysia/local area, do not reject on weak shared Malay/Indo words alone.
    if malaysia_hits and not strong_geo_or_currency and not strong_language:
        return False, hits[:6]
    return bool(strong_geo_or_currency or strong_language or len(hits) >= 2), hits[:6]


def parse_json_object_from_text(text: str) -> Optional[Dict[str, Any]]:
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass
    first = raw.find("{")
    last = raw.rfind("}")
    if first < 0 or last <= first:
        return None
    try:
        parsed = json.loads(raw[first:last + 1])
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def normalize_language_label(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if not value:
        return "unknown"
    if "indon" in value:
        return "indonesian"
    if any(token in value for token in ["manglish", "malay", "melayu", "bahasa malaysia", "bahasa melayu", "bm"]):
        return "malay"
    if any(token in value for token in ["english", "inggeris", "en"]):
        return "english"
    if "mixed" in value:
        return "mixed"
    return "other"


def normalize_required_language(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if value in {"malay", "bm", "bahasa", "bahasa-melayu", "bahasa_melayu", "melayu"}:
        return "malay"
    if value in {"english", "en", "inggeris"}:
        return "english"
    return "either"


def language_matches_required(language: str, required_language: str, contains_indonesian: bool = False) -> bool:
    if contains_indonesian or language == "indonesian":
        return False
    expected = normalize_required_language(required_language)
    if expected == "malay":
        return language in {"malay", "mixed"}
    if expected == "english":
        return language == "english"
    return language in {"malay", "english", "mixed"}


def run_hermes_classifier(prompt: str, timeout_seconds: int = 90, source: str = "lightpanda-threads-language") -> str:
    hermes_bin = os.environ.get("HERMES_BIN") or "hermes"
    cmd = [
        hermes_bin,
        "chat",
        "-Q",
        "--ignore-rules",
        "--max-turns",
        "1",
        "--source",
        source,
        "-q",
        prompt,
    ]
    env = os.environ.copy()
    env["HERMES_HOME"] = env.get("HERMES_HOME") or HERMES_HOME
    result = subprocess.run(
        cmd,
        cwd=str(ROOT),
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout_seconds,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit code {result.returncode}").strip()
        raise RuntimeError(truncate(detail, 300))
    return result.stdout or ""


def run_hermes_language_classifier(prompt: str, timeout_seconds: int = 90) -> str:
    return run_hermes_classifier(prompt, timeout_seconds, "lightpanda-threads-language")


def run_hermes_buyer_intent_classifier(prompt: str, timeout_seconds: int = 90) -> str:
    return run_hermes_classifier(prompt, timeout_seconds, "lightpanda-threads-buyer-intent")


def classify_language_with_ai(account: Dict[str, Any], keyword: str, post: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    """Ask Hermes AI to decide post language from the extracted full post text.

    The deterministic Indonesian cue list is now only evidence for the prompt/logs;
    it is not the final reject decision. Runtime fails closed if the AI classifier
    is enabled but unavailable, so Indonesian posts are not accepted by heuristic
    fallback after a model/API outage.
    """
    post_text = clean_post_text("\n".join(str(part or "") for part in [
        post.get("title"),
        post.get("ogTitle"),
        post.get("description"),
        post.get("text"),
    ]))
    required_language = account.get("requiredLanguage") or config.get("requiredLanguage") or "either"

    if config.get("aiLanguageClassifierEnabled", True) is False:
        indonesian_like, hits = detect_indonesian_like(post_text)
        return {
            "language": "indonesian" if indonesian_like else "unknown",
            "containsIndonesian": indonesian_like,
            "allowed": not indonesian_like,
            "confidence": 0.55,
            "source": "heuristic-language-disabled-ai",
            "reason": "AI language classifier disabled; deterministic cue fallback used.",
            "evidence": hits,
        }

    indonesian_like, indonesian_hits = detect_indonesian_like(post_text)
    prompt = "\n\n".join([
        "You are language-gating a Threads lead candidate for Zakwan in Malaysia.",
        "Read the WHOLE post text/context below, not just one keyword, search snippet, or cue list.",
        "Decide whether the post is Malaysian Bahasa Melayu/Manglish, English, Indonesian/Indon, mixed BM+English, or other.",
        "Important: Malay and Indonesian share many words. Do NOT reject from one isolated shared word. Use the whole post style, slang, geography, currency, and intent context.",
        "Reject Indonesian/Indon posts. Allow only the configured target language: requiredLanguage=either allows BM/Manglish or English; malay allows BM/Manglish only; english allows English only.",
        "Return ONLY strict JSON with keys: language (malay|english|indonesian|mixed|other|unknown), containsIndonesian (boolean), allowed (boolean), confidence (0..1), reason, evidence (array of short quotes).",
        f"Metadata: {json.dumps({'account': account.get('label') or account.get('id') or '', 'keyword': keyword, 'requiredLanguage': required_language, 'url': post.get('url') or ''}, ensure_ascii=False)}",
        f"Heuristic cue hints only, not final decision: {json.dumps(indonesian_hits, ensure_ascii=False)}",
        "Full post text read from the opened Threads post:",
        truncate(post_text, int(config.get("aiLanguageMaxChars", 3200))),
    ])
    try:
        output = run_hermes_language_classifier(prompt, int(config.get("aiLanguageTimeoutSeconds", 90)))
        parsed = parse_json_object_from_text(output)
        if not parsed:
            raise RuntimeError("AI returned non-JSON language decision")
        language = normalize_language_label(parsed.get("language"))
        contains_indonesian = bool(parsed.get("containsIndonesian") or language == "indonesian")
        allowed_by_required = language_matches_required(language, required_language, contains_indonesian)
        allowed = bool(parsed.get("allowed")) and allowed_by_required
        return {
            "language": language,
            "containsIndonesian": contains_indonesian,
            "allowed": allowed,
            "confidence": max(0.0, min(1.0, float(parsed.get("confidence") or 0))),
            "source": str(parsed.get("source") or "hermes-ai-language"),
            "reason": truncate(parsed.get("reason") or "AI language decision.", 260),
            "evidence": [truncate(item, 90) for item in parsed.get("evidence", [])[:6]] if isinstance(parsed.get("evidence"), list) else [],
            "requiredLanguage": normalize_required_language(required_language),
            "heuristicCueHints": indonesian_hits,
        }
    except Exception as exc:
        return {
            "language": "unknown",
            "containsIndonesian": False,
            "allowed": False,
            "confidence": 0.0,
            "source": "hermes-ai-language-error",
            "reason": "AI language classifier failed; rejected fail-closed instead of accepting heuristic-only output.",
            "error": truncate(str(exc), 260),
            "requiredLanguage": normalize_required_language(required_language),
            "heuristicCueHints": indonesian_hits,
        }


BUYER_REGEXES = [
    r"\b(?:saya|sy|sye|aku|kami|kita|i|me|family|keluarga|mak|ibu|ayah|parents|isteri|suami|wife|husband)\b.{0,140}\b(?:cari|mencari|looking\s+for|need|perlukan|nak\s+(?:beli|sewa|cari)|mahu\s+(?:beli|sewa|cari)|want\s+to\s+(?:buy|rent)|looking\s+to\s+(?:buy|rent))\b",
    r"\b(?:nak|mahu|mau|ingin|looking\s+to|want\s+to|need\s+to)\s+(?:cari|mencari|beli|buy|sewa|rent|survey)\b.{0,160}\b(?:rumah|house|property|hartanah|tanah|land|lot|bilik|room|area|kawasan|budget|bajet|rm)\b",
    r"\b(?:wtb|want\s+to\s+buy|looking\s+to\s+buy|looking\s+to\s+rent|looking\s+for|need|wanted|req|request|perlukan)\b.{0,140}\b(?:rumah|house|property|hartanah|tanah|land|lot|bilik|room|sewa|rent|buy|beli)\b",
    r"\b(?:ada\s+tak|ada\s+x|ada\s+ka|anyone|siapa\s+ada|sapa\s+ada|recommend|cadang|suggest|boleh\s+(?:suggest|share|recommend)|tolong\s+recommend)\b.{0,150}\b(?:rumah|house|property|tanah|land|lot|sewa|rent|jual|beli|buy|owner|area|kawasan)\b",
    r"\b(?:budget|bajet)\b.{0,120}\b(?:rm|rumah|house|sewa|rent|beli|buy|property|hartanah)\b.{0,150}\b(?:ada\s+tak|boleh\s+share|owner|recommend|cari|nak|looking)\b",
    r"\b(?:mak|ibu|mother|family|keluarga|parents)\b.{0,140}\b(?:cari\s+rumah|rumah\s+sewa|beli\s+rumah|sewa\s+rumah)\b",
    r"\b(?:ramai|org|orang|people)\b.{0,100}\b(?:cari\s+rumah|rumah\s+sewa|looking\s+for\s+(?:house|room|rent))\b",
    r"\b(?:rumah\s+pertama|first\s+house|untuk\s+didiami|nak\s+duduk|ini\s+untuk\s+mak)\b",
]
PROPERTY_REGEXES = [
    r"\b(?:rumah|house|property|hartanah|tanah|land|lot|bilik|room|homestay|teres|apartment|condo|sewa|rent|beli|buy)\b",
]
SELLER_REGEXES = [
    r"\b(?:untuk\s+dijual|dijual|for\s+sale|wts|want\s+to\s+sell|owner\s+nak\s+jual|rumah\s+untuk\s+jual|tanah\s+untuk\s+jual)\b",
    r"\b(?:untuk\s+disewa|disewakan|for\s+rent|available\s+for\s+rent|unit\s+available|kemasukan|masuk\s+segera|booking\s+dibuka|open\s+booking)\b",
    r"\b(?:agent|ejen|realtor|ren\s*\d+|negotiator|perunding\s+hartanah|pemaju|developer)\b",
    r"\b(?:whatsapp|wasap|call|hubungi|contact|pm\s+(?:tepi|me|saya)|dm\s+(?:me|saya)|berminat\s+boleh)\b",
    r"(?:\+?6?01\d[-\s]?\d{3,4}[-\s]?\d{3,4})",
    r"\b(?:full\s+loan|cashback|booking\s+fee|freehold|leasehold|renovated|ubahsuai|kitchen\s+cabinet|plaster\s+ceiling|corner\s+lot|semi[-\s]?d|teres\s+(?:setingkat|2\s+tingkat|dua\s+tingkat))\b",
    r"\b(?:harga|price|installment|monthly|bulan|ansuran)\s*[:\-]?\s*rm\s*\d",
]
RHETORICAL_SELLER_REGEXES = [
    r"\b(?:masih\s+relevan\s+ke|mana\s+lagi\s+nak\s+dapat|dah\s+penat\s+cari|masih\s+cari)\b",
    r"\bcari\s+rumah\s+(?:area|kawasan|sekitar|bawah)\b.{0,100}\?",
    r"\b(?:bawah|under)\s+rm\s*\d[\d,.]*(?:\s*(?:juta|k|ribu))?\b",
]


def regex_hits(patterns: List[str], text: str) -> List[str]:
    hits: List[str] = []
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if match:
            hits.append(truncate(match.group(0), 90))
    return list(dict.fromkeys(hits))


def classify_property_buyer(post: Dict[str, Any], min_confidence: float = 0.68) -> Dict[str, Any]:
    compact = clean_post_text(f"{post.get('description') or ''} {post.get('title') or ''} {post.get('text') or ''}")
    text = compact.lower()
    property_signals = regex_hits(PROPERTY_REGEXES, text)
    buyer_signals = regex_hits(BUYER_REGEXES, text)
    seller_signals = regex_hits(SELLER_REGEXES, text) + regex_hits(RHETORICAL_SELLER_REGEXES, text)
    if not property_signals:
        return {"intent": "irrelevant", "confidence": 0.92, "source": "lightpanda-heuristic", "reason": "No property/rent/buy signal detected.", "buyerSignals": buyer_signals, "sellerSignals": seller_signals}
    if buyer_signals and len(seller_signals) <= 1:
        confidence = min(0.92, 0.70 + 0.05 * len(buyer_signals) - 0.04 * len(seller_signals))
        return {"intent": "buyer", "confidence": round(confidence, 2), "source": "lightpanda-heuristic", "reason": "Buyer/searcher phrasing detected and seller/listing signals do not dominate.", "buyerSignals": buyer_signals[:6], "sellerSignals": seller_signals[:6], "accepted": confidence >= min_confidence}
    if len(seller_signals) > len(buyer_signals):
        return {"intent": "seller", "confidence": min(0.94, 0.68 + 0.06 * len(seller_signals)), "source": "lightpanda-heuristic", "reason": "Seller/listing/contact/price signals outweigh buyer intent.", "buyerSignals": buyer_signals[:6], "sellerSignals": seller_signals[:6]}
    return {"intent": "unclear" if buyer_signals else "irrelevant", "confidence": 0.56 if buyer_signals else 0.78, "source": "lightpanda-heuristic", "reason": "Property terms exist, but buyer intent is not clear enough.", "buyerSignals": buyer_signals[:6], "sellerSignals": seller_signals[:6]}


def normalize_buyer_intent(raw: Any) -> str:
    value = str(raw or "").strip().lower().replace("-", "_").replace(" ", "_")
    if value in {"buyer", "searcher", "renter", "tenant", "looking", "looking_to_buy", "looking_to_rent", "buy", "rent"}:
        return "buyer"
    if value in {"seller", "listing", "agent", "realtor", "landlord", "owner_selling", "owner_listing", "advertisement"}:
        return "seller"
    if value in {"irrelevant", "not_relevant", "unrelated", "noise", "food", "matcha", "joke"}:
        return "irrelevant"
    if value in {"unclear", "unknown", "ambiguous", "not_sure"}:
        return "unclear"
    return "unclear"


def property_buyer_post_text(post: Dict[str, Any]) -> str:
    return clean_post_text("\n".join(str(part or "") for part in [
        post.get("title"),
        post.get("ogTitle"),
        post.get("description"),
        post.get("text"),
        post.get("postText"),
    ]))


def classify_property_buyer_with_ai(account: Dict[str, Any], keyword: str, post: Dict[str, Any], config: Dict[str, Any], min_confidence: float = 0.68) -> Dict[str, Any]:
    """Ask Hermes AI to decide property buyer intent from the opened full post.

    The regex classifier is only a hint for the prompt / disabled-AI fallback.
    Runtime defaults to Hermes AI and fails closed on AI errors so a misleading
    keyword such as "cari rumah dia" + "I bought matcha" is not accepted as a
    house-buyer lead.
    """
    heuristic = classify_property_buyer(post, min_confidence=min_confidence)
    if config.get("aiBuyerIntentClassifierEnabled", True) is False:
        out = dict(heuristic)
        out.setdefault("accepted", out.get("intent") == "buyer" and float(out.get("confidence") or 0) >= min_confidence)
        return out

    post_text = property_buyer_post_text(post)
    image_urls = [str(u) for u in (post.get("imageUrls") or []) if str(u).strip()]
    prompt = "\n\n".join([
        "You are buyer-intent gating a Threads property lead candidate for Zakwan in Malaysia.",
        "Read the WHOLE post text/context below, not just one keyword, search snippet, or cue list.",
        "Decide whether the author is currently or near-future looking to buy/rent/sewa/search for a house, room, land, or property.",
        "Reject irrelevant uses of property words, including visiting/finding someone's house/location, food or matcha purchases, jokes, reviews, sellers/listings/agents, and unrelated products.",
        "The search keyword may be misleading. Do NOT accept just because the keyword matched; the whole post must express property buyer/renter/search intent.",
        "Weak but real current/near-future buy/rent/search intent is acceptable. Past tense purchase of a non-property item is not acceptable.",
        "Return ONLY strict JSON with keys: intent (buyer|seller|irrelevant|unclear), accepted (boolean), confidence (0..1), reason, evidence (array of short quotes), buyerSignals (array), sellerSignals (array).",
        f"Metadata: {json.dumps({'account': account.get('label') or account.get('id') or '', 'keyword': keyword, 'minConfidence': min_confidence, 'url': post.get('url') or ''}, ensure_ascii=False)}",
        f"Heuristic regex hints only, not final decision: {json.dumps(heuristic, ensure_ascii=False)}",
        f"Image URLs observed (supporting context only): {json.dumps(image_urls[:4], ensure_ascii=False)}",
        "Full post text read from the opened Threads post:",
        truncate(post_text, int(config.get("aiBuyerIntentMaxChars", config.get("aiLanguageMaxChars", 3200)))),
    ])
    try:
        output = run_hermes_buyer_intent_classifier(prompt, int(config.get("aiBuyerIntentTimeoutSeconds", config.get("aiLanguageTimeoutSeconds", 90))))
        parsed = parse_json_object_from_text(output)
        if not parsed:
            raise RuntimeError("AI returned non-JSON buyer-intent decision")
        intent = normalize_buyer_intent(parsed.get("intent"))
        confidence = max(0.0, min(1.0, float(parsed.get("confidence") or 0)))
        accepted = bool(parsed.get("accepted")) and intent == "buyer" and confidence >= min_confidence
        return {
            "intent": intent,
            "confidence": confidence,
            "source": str(parsed.get("source") or "hermes-ai-buyer-intent"),
            "reason": truncate(parsed.get("reason") or "AI buyer-intent decision.", 320),
            "buyerSignals": [truncate(item, 110) for item in parsed.get("buyerSignals", [])[:6]] if isinstance(parsed.get("buyerSignals"), list) else [],
            "sellerSignals": [truncate(item, 110) for item in parsed.get("sellerSignals", [])[:6]] if isinstance(parsed.get("sellerSignals"), list) else [],
            "evidence": [truncate(item, 110) for item in parsed.get("evidence", [])[:6]] if isinstance(parsed.get("evidence"), list) else [],
            "accepted": accepted,
            "heuristic": heuristic,
        }
    except Exception as exc:
        return {
            "intent": "unclear",
            "confidence": 0.0,
            "source": "hermes-ai-buyer-intent-error",
            "reason": "AI buyer-intent classifier failed; rejected fail-closed instead of accepting heuristic-only output.",
            "error": truncate(str(exc), 260),
            "buyerSignals": [],
            "sellerSignals": [],
            "accepted": False,
            "heuristic": heuristic,
        }


def score_candidate(account: Dict[str, Any], keyword: str, post: Dict[str, Any], config: Optional[Dict[str, Any]] = None, language_decision: Optional[Dict[str, Any]] = None) -> Tuple[bool, List[str], int, Dict[str, Any]]:
    config = config or {}
    mode = str(account.get("intentMode") or "").lower()
    text = f"{post.get('description') or ''} {post.get('title') or ''} {post.get('text') or ''}".lower()
    reasons: List[str] = []
    score = 0
    if keyword and keyword.lower() in text:
        score += 2
        reasons.append(f"matched keyword: {keyword}")

    if any(term in text for term in NOISE_TERMS):
        score -= 2
        reasons.append("noise term detected")

    language_allowed = True
    if language_decision:
        language_allowed = bool(language_decision.get("allowed"))
        language_label = str(language_decision.get("language") or "unknown")
        if language_allowed:
            reasons.append(f"AI language accepted: {language_label} ({language_decision.get('source') or 'ai'})")
        else:
            score -= 4
            reasons.append(f"AI language rejected: {language_label} - {language_decision.get('reason') or 'not target language'}")
    else:
        # Unit-test/backward-compatible fallback only. Runtime passes a Hermes AI
        # decision after opening and reading the full post.
        indonesian_like, indonesian_hits = detect_indonesian_like(text)
        language_allowed = not indonesian_like
        if indonesian_like:
            score -= 4
            reasons.append("Fallback Indonesian/non-target language cue detected from full post: " + ", ".join(indonesian_hits[:4]))

    buyer_intent: Dict[str, Any] = {}
    if mode == "property":
        min_confidence = float(account.get("buyerIntentMinConfidence") or config.get("buyerIntentMinConfidence") or 0.68)
        if language_allowed:
            buyer_intent = classify_property_buyer_with_ai(account, keyword, post, config, min_confidence=min_confidence)
        else:
            buyer_intent = {
                "intent": "not_evaluated",
                "confidence": 0.0,
                "source": "skipped-language-rejected",
                "reason": "Buyer intent skipped because language gate rejected the post.",
                "accepted": False,
            }
        hits = [term for term in PROPERTY_INTENT if term in text]
        if hits:
            score += 2
            reasons.append("property topic: " + ", ".join(hits[:3]))
        if buyer_intent.get("accepted") and buyer_intent.get("intent") == "buyer":
            score += 4
            reasons.append(f"buyer intent {buyer_intent.get('confidence')}: {buyer_intent.get('reason')}")
        else:
            reasons.append(f"buyer intent rejected: {buyer_intent.get('intent')} - {buyer_intent.get('reason')}")
        buyer_only = bool(account.get("buyerIntentOnly", True))
        buyer_ok = bool(buyer_intent.get("accepted") and buyer_intent.get("intent") == "buyer" and float(buyer_intent.get("confidence") or 0) >= min_confidence)
        candidate = bool((not buyer_only or buyer_ok) and language_allowed and score >= 4)
    elif mode == "automation":
        automation_terms = [str(k).lower() for k in account.get("keywords") or [] if str(k).strip()]
        has_topic = any(term in text for term in automation_terms[:20])
        intent_hits = [term for term in AUTOMATION_INTENT if term in text]
        if has_topic:
            score += 2
            reasons.append("automation topic present")
        if intent_hits:
            score += 3
            reasons.append("intent cue: " + ", ".join(intent_hits[:3]))
        candidate = bool(has_topic and intent_hits and language_allowed and score >= 4)
    else:
        candidate = bool(language_allowed and score >= 2)

    if not reasons:
        reasons.append("keyword/search match only")
    return candidate, reasons, score, buyer_intent


def read_seen() -> Set[str]:
    data = load_json(SEEN_PATH, {}) or {}
    values = data.get("seen", []) if isinstance(data, dict) else []
    out: Set[str] = set()
    for value in values:
        key = post_key(str(value or ""))
        if key:
            out.add(key)
    return out


def write_seen(seen: Set[str]) -> None:
    normalized = {post_key(value) for value in seen if post_key(value)}
    write_json(SEEN_PATH, {"seen": sorted(normalized), "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %z")})


def dashboard_state_seen_keys(config: Dict[str, Any]) -> Set[str]:
    """Return post keys already present in dashboard-compatible action state.

    Lightpanda writes action JSON into the dashboard Threads state directory so
    the existing Telegram callback flow can handle Lily/Me/Skip. Seed the local
    seen set from that directory too, otherwise old Patchright/dashboard states
    can be rediscovered via history-seed or external search and sent again.
    """
    if config.get("seedSeenFromDashboardState", True) is False:
        return set()
    state_dir = telegram_action_state_dir(config)
    if not state_dir.exists():
        return set()
    out: Set[str] = set()
    try:
        candidates = list(state_dir.glob("*.json"))
    except OSError:
        return out
    for state_path in candidates:
        if state_path.name.startswith("_"):
            continue
        data = load_json(state_path, {}) or {}
        if not isinstance(data, dict):
            continue
        key = post_key(str(((data.get("post") or {}).get("url")) or ""))
        if key:
            out.add(key)
    return out


def proc_stat(pid: int) -> Optional[List[str]]:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].strip().split()
    except Exception:
        return None


def proc_cpu_seconds(pid: int) -> float:
    stat = proc_stat(pid)
    if not stat:
        return 0.0
    return (int(stat[11]) + int(stat[12])) / HZ


def proc_mem(pid: int) -> Dict[str, float]:
    out = {"rss_mb": 0.0, "pss_mb": 0.0, "private_mb": 0.0, "shared_mb": 0.0}
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                out["rss_mb"] = int(line.split()[1]) / 1024.0
                break
    except Exception:
        pass
    try:
        vals: Dict[str, int] = {}
        for line in Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
            parts = line.split()
            if len(parts) >= 2:
                vals[parts[0].rstrip(":")] = int(parts[1])
        out["pss_mb"] = vals.get("Pss", 0) / 1024.0 or out["rss_mb"]
        out["private_mb"] = (vals.get("Private_Clean", 0) + vals.get("Private_Dirty", 0)) / 1024.0
        out["shared_mb"] = (vals.get("Shared_Clean", 0) + vals.get("Shared_Dirty", 0)) / 1024.0
    except Exception:
        out["pss_mb"] = out["rss_mb"]
        out["private_mb"] = out["rss_mb"]
    return out


def sample_proc(pid: int, prev_cpu: Optional[float], prev_time: Optional[float]) -> Tuple[Dict[str, Any], float, float]:
    now = time.time()
    cpu_total = proc_cpu_seconds(pid)
    mem = proc_mem(pid)
    cpu_pct = None
    if prev_cpu is not None and prev_time is not None:
        cpu_pct = max(0.0, (cpu_total - prev_cpu) / max(now - prev_time, 1e-6) * 100.0)
    return ({
        "t": now,
        "pidCount": 1 if Path(f"/proc/{pid}").exists() else 0,
        "rssMb": mem["rss_mb"],
        "pssMb": mem["pss_mb"],
        "privateMb": mem["private_mb"],
        "sharedMb": mem["shared_mb"],
        "cpuPercent": cpu_pct,
    }, cpu_total, now)


def summarize_samples(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    def vals(key: str) -> List[float]:
        return [float(s.get(key) or 0.0) for s in samples]
    cpus = [float(s["cpuPercent"]) for s in samples if s.get("cpuPercent") is not None]
    return {
        "samples": len(samples),
        "peakRssMb": round(max(vals("rssMb") or [0.0]), 1),
        "avgRssMb": round(sum(vals("rssMb")) / max(len(samples), 1), 1),
        "peakPssMb": round(max(vals("pssMb") or [0.0]), 1),
        "avgPssMb": round(sum(vals("pssMb")) / max(len(samples), 1), 1),
        "peakPrivateMb": round(max(vals("privateMb") or [0.0]), 1),
        "avgPrivateMb": round(sum(vals("privateMb")) / max(len(samples), 1), 1),
        "peakCpuPercent": round(max(cpus), 1) if cpus else 0.0,
        "avgCpuPercent": round(sum(cpus) / len(cpus), 1) if cpus else 0.0,
        "peakProcessCount": max((int(s.get("pidCount") or 0) for s in samples), default=0),
    }


def import_cookies(config_path: Path, account_id: str) -> None:
    subprocess.run([sys.executable, str(IMPORT_SCRIPT), "--config", str(config_path), "--account", account_id], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def telegram_target(config: Dict[str, Any]) -> Tuple[Optional[str], Optional[int]]:
    settings = load_json(Path(config.get("dashboardSettingsPath", "")), {}) or {}
    threads = settings.get("threads") if isinstance(settings, dict) else {}
    tg = config.get("telegram") if isinstance(config.get("telegram"), dict) else {}
    # Lightpanda has its own destination override so we can send to a separate
    # Telegram topic without touching the live dashboard/Patchright settings.
    chat_id = str(config.get("telegramChatId") or tg.get("chatId") or (threads or {}).get("telegramChatId") or settings.get("telegramChatId") or "").strip()
    thread_raw = config.get("telegramThreadId", tg.get("threadId", (threads or {}).get("telegramThreadId", settings.get("telegramThreadId"))))
    try:
        thread_id = int(thread_raw) if thread_raw not in (None, "") else None
    except Exception:
        thread_id = None
    return chat_id or None, thread_id


def telegram_token(config: Dict[str, Any]) -> str:
    env = os.environ.get("TELEGRAM_BOT_TOKEN") or os.environ.get("BOT_TOKEN")
    if env:
        return env.strip()
    token_path = Path(config.get("telegramTokenPath") or "").expanduser()
    if token_path.exists():
        token = token_path.read_text(encoding="utf-8").strip()
        if token:
            return token
    env_path = Path(config.get("telegramEnvPath") or "/root/.hermes/.env").expanduser()
    if env_path.exists():
        for raw in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() in {"TELEGRAM_BOT_TOKEN", "BOT_TOKEN"}:
                token = value.strip().strip('"').strip("'")
                if token:
                    return token
    raise RuntimeError("Telegram token unavailable for Lightpanda finder")


def base36(number: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    n = max(0, int(number))
    if n == 0:
        return "0"
    out = ""
    while n:
        n, rem = divmod(n, 36)
        out = alphabet[rem] + out
    return out


def iso_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_action_id(prefix: str = "thrrec") -> str:
    return f"{prefix}_{base36(int(time.time() * 1000))}_{uuid.uuid4().hex[:6]}"


def create_short_id() -> str:
    return uuid.uuid4().hex[:6]


def extract_handle_from_url(url: str) -> str:
    match = re.search(r"/(?:@([^/]+)/post/|t/)", str(url or ""))
    return match.group(1) if match and match.group(1) else ""


def telegram_action_state_dir(config: Dict[str, Any]) -> Path:
    configured = str(config.get("telegramActionStateDir") or config.get("dashboardThreadsStateDir") or "").strip()
    return Path(configured).expanduser() if configured else DEFAULT_THREADS_ACTION_STATE_DIR


def build_telegram_buttons(job_id: str) -> List[Dict[str, str]]:
    return [
        {"label": "🤖 Lily", "value": f"threads_recent:auto:{job_id}"},
        {"label": "✍️ Me", "value": f"threads_recent:manual:{job_id}"},
    ]


def build_telegram_inline_keyboard(buttons: Optional[List[Dict[str, str]]]) -> Optional[Dict[str, Any]]:
    if not buttons:
        return None
    rows = []
    for button in buttons:
        label = str(button.get("label") or button.get("text") or "").strip()
        value = str(button.get("value") or button.get("callback_data") or "").strip()
        if label and value:
            rows.append([{"text": label, "callback_data": value[:64]}])
    return {"inline_keyboard": rows} if rows else None


def build_threads_action_state(config: Dict[str, Any], account: Dict[str, Any], candidate: Dict[str, Any]) -> Dict[str, Any]:
    chat_id, thread_id = telegram_target(config)
    now = iso_timestamp()
    job_id = create_action_id("thrrec")
    post_text = candidate.get("text") or candidate.get("description") or candidate.get("title") or ""
    comment_guideline = str(account.get("commentGuideline") or config.get("commentGuideline") or "").strip()
    auto = effective_auto_comment(config, account)
    return {
        "id": job_id,
        "shortId": create_short_id(),
        "createdAt": now,
        "updatedAt": now,
        "status": "awaiting_action",
        "post": {
            "keyword": candidate.get("keyword") or "",
            "url": candidate.get("url") or "",
            "handle": candidate.get("handle") or extract_handle_from_url(candidate.get("url") or ""),
            "language": (candidate.get("languageDecision") or {}).get("language") or candidate.get("language") or "",
            "languageDecision": candidate.get("languageDecision") or None,
            "content": post_text,
            "publishedAt": candidate.get("publishedAt") or "",
            "buyerIntent": candidate.get("buyerIntent") or None,
        },
        "telegram": {
            "chatId": chat_id or "",
            "threadId": thread_id,
            "topicLink": config.get("telegramTopicLink") or "",
        },
        "filters": {
            "requiredLanguage": account.get("requiredLanguage") or "either",
            "keywords": [str(k).strip() for k in account.get("keywords") or [] if str(k).strip()],
            "buyerIntentOnly": account.get("buyerIntentOnly", True) is not False,
            "buyerIntentAiEnabled": bool(config.get("aiBuyerIntentClassifierEnabled", True)),
            "buyerIntentMinConfidence": float(account.get("buyerIntentMinConfidence") or config.get("buyerIntentMinConfidence") or 0.68),
            "maxCandidatesPerRun": int(config.get("maxCandidatesPerAccount") or 1),
        },
        "commentSettings": {
            "autoCommentEnabled": bool(auto.get("enabled")),
            "commentSubmitEnabled": bool(auto.get("submit")),
            "replyStyle": account.get("replyStyle") or config.get("replyStyle") or "gaya-a",
            "includeCta": bool(account.get("includeCta") or config.get("includeCta") or False),
            "ctaText": str(account.get("ctaText") or config.get("ctaText") or "").strip(),
            "commentGuideline": comment_guideline,
            "commentTemplate": "",
            "aiReplyEnabled": True,
        },
        "browser": {
            "source": config.get("browserSource", "PandaBrowser/Lightpanda"),
            "storageStatePath": account.get("storageStatePath") or "",
            "accountId": str(account.get("id") or ""),
            "accountLabel": str(account.get("label") or account.get("id") or ""),
            "channel": account.get("channel") or "",
            "locale": account.get("locale") or config.get("locale") or "en-US",
        },
        "previewMessageIds": [],
        "lastCommentText": "",
        "lastError": "",
        "skippedUrls": [],
        "parentJobId": "",
        "source": {
            "runner": "lightpanda-threads-finder",
            "runId": candidate.get("runId") or "",
            "discoverySource": candidate.get("discoverySource") or "threads-search",
            "score": candidate.get("score"),
        },
    }


def write_threads_action_state(config: Dict[str, Any], state: Dict[str, Any]) -> Path:
    path = telegram_action_state_dir(config) / f"{state['id']}.json"
    write_json(path, state)
    if sqlite_record_action_state is not None:
        try:
            sqlite_record_action_state(state, SQLITE_DB_PATH)
        except Exception:
            pass
    return path


def telegram_message_id(data: Dict[str, Any]) -> Optional[int]:
    raw = data.get("message_id")
    if raw is None and isinstance(data.get("result"), dict):
        raw = data["result"].get("message_id")
    try:
        return int(raw) if raw is not None else None
    except Exception:
        return None


def telegram_send_result(data: Dict[str, Any], thread_id: Optional[int], buttons: Optional[List[Dict[str, str]]], *, rich_message: bool, rich_fallback: bool = False, rich_error: str = "") -> Dict[str, Any]:
    result = {
        "ok": bool(data.get("ok")),
        "messageId": telegram_message_id(data),
        "threadConfigured": thread_id is not None,
        "buttonCount": len(buttons or []),
        "buttonLabels": [b.get("label") for b in (buttons or [])],
        "richMessage": rich_message,
    }
    if rich_fallback:
        result["richFallback"] = True
    if rich_error:
        result["richError"] = rich_error[:240]
    return result


def send_telegram(config: Dict[str, Any], text: str, dry_run: bool = False, buttons: Optional[List[Dict[str, str]]] = None, rich_text: Optional[str] = None) -> Dict[str, Any]:
    chat_id, thread_id = telegram_target(config)
    reply_markup = build_telegram_inline_keyboard(buttons)
    if not chat_id:
        return {"ok": False, "skipped": True, "reason": "missing telegram chat id"}
    if dry_run or not config.get("sendTelegram", True):
        return {
            "ok": True,
            "skipped": True,
            "reason": "dry-run/no-send",
            "chatConfigured": True,
            "threadConfigured": thread_id is not None,
            "buttonCount": len(buttons or []),
            "buttonLabels": [b.get("label") for b in (buttons or [])],
            "richMessageConfigured": bool(str(rich_text or "").strip()),
        }
    token = telegram_token(config)
    base_payload: Dict[str, Any] = {"chat_id": chat_id}
    if thread_id is not None:
        base_payload["message_thread_id"] = thread_id
    if reply_markup:
        base_payload["reply_markup"] = reply_markup

    rich_error = ""
    if str(rich_text or "").strip():
        rich_payload: Dict[str, Any] = {
            **base_payload,
            "rich_message": {"text": str(rich_text or "").strip()[:3800]},
        }
        rich_res = requests.post(f"https://api.telegram.org/bot{token}/sendRichMessage", json=rich_payload, timeout=20)
        if rich_res.ok:
            data = rich_res.json()
            return telegram_send_result(data, thread_id, buttons, rich_message=True)
        rich_error = f"HTTP {rich_res.status_code} {rich_res.text[:200]}"

    payload: Dict[str, Any] = {**base_payload, "text": text[:3800], "disable_web_page_preview": False}
    res = requests.post(f"https://api.telegram.org/bot{token}/sendMessage", json=payload, timeout=20)
    if not res.ok:
        raise RuntimeError(f"Telegram send failed: HTTP {res.status_code} {res.text[:200]}")
    data = res.json()
    return telegram_send_result(
        data,
        thread_id,
        buttons,
        rich_message=False,
        rich_fallback=bool(rich_error),
        rich_error=rich_error,
    )


def compact_post_text_for_telegram(text: Any, limit: int = 1600) -> str:
    raw = str(text or "").strip()
    if not raw:
        return "[empty]"
    # Threads extraction can return duplicated article text. Deduplicate exact repeated
    # lines and also collapse the common "same text twice" whole-block pattern.
    normalized = re.sub(r"\s+", " ", raw).strip()
    half = len(normalized) // 2
    if half > 80:
        left = normalized[:half].strip(" .\n\t")
        right = normalized[half:].strip(" .\n\t")
        if left and right and (left == right or left.startswith(right[: max(40, len(right)//2)]) or right.startswith(left[: max(40, len(left)//2)])):
            normalized = left if len(left) <= len(right) else right
    lines: List[str] = []
    seen_lines: Set[str] = set()
    for line in re.split(r"[\r\n]+", raw):
        clean = re.sub(r"\s+", " ", line).strip()
        if not clean:
            continue
        key = clean.lower()
        if key in seen_lines:
            continue
        seen_lines.add(key)
        lines.append(clean)
    compact = "\n".join(lines).strip() if lines else normalized
    if len(compact) > limit:
        compact = truncate(compact, limit)
    return compact


def trigger_auto_comment_for_state(state: Dict[str, Any], *, dry_run: bool = False) -> Dict[str, Any]:
    if dry_run:
        return {"ok": True, "skipped": True, "reason": "dry-run"}
    job_id = str(state.get("id") or "").strip()
    if not job_id:
        return {"ok": False, "error": "missing job id"}
    env = {**os.environ, "HERMES_HOME": HERMES_HOME}
    try:
        result = subprocess.run(
            ["node", str(THREADS_RECENT_FLOW_SCRIPT), "comment-auto", f"--job-id={job_id}"],
            cwd=str(DASHBOARD_ROOT),
            env=env,
            text=True,
            capture_output=True,
            timeout=300,
            check=False,
        )
        return {
            "ok": result.returncode == 0,
            "exitCode": result.returncode,
            "stdout": (result.stdout or "")[-2000:],
            "stderr": (result.stderr or "")[-2000:],
            "script": str(THREADS_RECENT_FLOW_SCRIPT),
        }
    except Exception as exc:
        return {"ok": False, "error": truncate(str(exc), 500), "script": str(THREADS_RECENT_FLOW_SCRIPT)}


def format_candidate(config: Dict[str, Any], account: Dict[str, Any], candidate: Dict[str, Any]) -> str:
    raw_post_text = candidate.get("text") or candidate.get("description") or candidate.get("title") or "[empty]"
    post_text = compact_post_text_for_telegram(raw_post_text, 1600)
    text_source = candidate.get("textSource") or "dom-post-text"
    post_char_count = len(str(raw_post_text or ""))
    lines = [
        "🔎 Threads candidate found",
        f"Source: {config.get('browserSource', 'PandaBrowser/Lightpanda')}",
        f"Account: {account.get('label') or account.get('id')}",
        f"Keyword: {candidate.get('keyword')}",
        "Reason: " + "; ".join(candidate.get("reasons") or []),
        "",
        "URL:",
        candidate.get("url") or "",
    ]
    if candidate.get("buyerIntent"):
        bi = candidate.get("buyerIntent") or {}
        lines += [
            "",
            f"Buyer reason: {truncate(bi.get('reason') or '', 420)}",
        ]
    auto = effective_auto_comment(config, account)
    lines += ["", f"Auto-comment: {'ON' if auto.get('enabled') else 'OFF'}", f"Comment submit: {'ON' if auto.get('submit') else 'OFF'}"]
    return "\n".join(lines).strip()


def format_candidate_rich(config: Dict[str, Any], account: Dict[str, Any], candidate: Dict[str, Any]) -> str:
    raw_post_text = candidate.get("text") or candidate.get("description") or candidate.get("title") or "[empty]"
    post_text = compact_post_text_for_telegram(raw_post_text, 1600)
    text_source = candidate.get("textSource") or "dom-post-text"
    language = candidate.get("languageDecision") or {}
    status = "allowed" if language.get("allowed") else "rejected"
    lines = [
        "# 🔎 Threads candidate found",
        f"**Source:** {config.get('browserSource', 'PandaBrowser/Lightpanda')}",
        f"**Account:** {account.get('label') or account.get('id')}",
        f"**Keyword:** {candidate.get('keyword')}",
        f"**Reason:** {'; '.join(candidate.get('reasons') or [])}",
    ]
    if candidate.get("buyerIntent"):
        bi = candidate.get("buyerIntent") or {}
        lines += [
            "",
            f"**Buyer reason:** {truncate(bi.get('reason') or '', 420)}",
        ]
    lines += [
        "",
        "## URL",
        candidate.get("url") or "",
    ]
    auto = effective_auto_comment(config, account)
    lines += ["", f"**Auto-comment:** {'ON' if auto.get('enabled') else 'OFF'}", f"**Comment submit:** {'ON' if auto.get('submit') else 'OFF'}"]
    return "\n".join(lines).strip()


class CDPClient:
    def __init__(self, ws_url: str):
        self.ws_url = ws_url
        self.ws = None
        self.next_id = 0

    async def __aenter__(self):
        self.ws = await websockets.connect(self.ws_url, max_size=100_000_000, ping_interval=None)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self.ws:
            await self.ws.close()

    async def send(self, method: str, params: Optional[Dict[str, Any]] = None, session_id: Optional[str] = None) -> Dict[str, Any]:
        self.next_id += 1
        msg: Dict[str, Any] = {"id": self.next_id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        assert self.ws is not None
        await self.ws.send(json.dumps(msg))
        while True:
            raw = await self.ws.recv()
            data = json.loads(raw)
            if data.get("id") == self.next_id:
                if "error" in data:
                    raise RuntimeError(f"CDP {method} failed: {data['error']}")
                return data


async def open_page(ws_url: str) -> Tuple[CDPClient, str]:
    cdp = CDPClient(ws_url)
    await cdp.__aenter__()
    target = await cdp.send("Target.createTarget", {"url": "about:blank"})
    target_id = target["result"]["targetId"]
    attached = await cdp.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
    sid = attached["result"]["sessionId"]
    await cdp.send("Page.enable", {}, sid)
    await cdp.send("Runtime.enable", {}, sid)
    return cdp, sid


async def evaluate_json(cdp: CDPClient, sid: str, expression: str) -> Any:
    res = await cdp.send("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True}, sid)
    value = res.get("result", {}).get("result", {}).get("value")
    if value is None:
        return None
    return json.loads(value)


async def navigate(cdp: CDPClient, sid: str, url: str, wait_seconds: float) -> None:
    await cdp.send("Page.navigate", {"url": url}, sid)
    await asyncio.sleep(wait_seconds)


def collect_relay_post_urls(payload: Any, limit: int) -> List[str]:
    """Extract Threads post URLs from Relay/SSR JSON when Lightpanda DOM render fails.

    Some Threads accounts return valid `searchResults.edges` in the preloaded
    Relay payload, but Lightpanda hits a React render error before anchors are
    mounted. Account @koiisss_ does this while @zakwan_termizi renders anchors.
    Pulling URLs from the in-page Relay JSON keeps the workflow Lightpanda-only
    and avoids falling back to Patchright/Chromium.
    """
    urls: List[str] = []
    seen: Set[str] = set()

    def push(raw: str) -> None:
        normalized = normalize_post_url(raw)
        if normalized and normalized not in seen:
            seen.add(normalized)
            urls.append(normalized)

    def push_post(post: Any) -> None:
        if not isinstance(post, dict) or len(urls) >= limit:
            return
        push(str(post.get("canonical_url") or post.get("url") or ""))
        user = post.get("user") if isinstance(post.get("user"), dict) else {}
        username = str(user.get("username") or "").strip().lstrip("@")
        code = str(post.get("code") or post.get("shortcode") or "").strip()
        if username and code:
            push(f"https://www.threads.net/@{username}/post/{code}")

    def walk(value: Any, depth: int = 0) -> None:
        if len(urls) >= limit or depth > 80:
            return
        if isinstance(value, dict):
            # Search result edges usually look like
            # edge.node.thread.thread_items[0].post.{user.username,code}.
            if isinstance(value.get("post"), dict):
                push_post(value.get("post"))
            push_post(value)
            for child in value.values():
                walk(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                if len(urls) >= limit:
                    break
                walk(child, depth + 1)
        elif isinstance(value, str):
            # Covers direct `/@user/post/code` strings if Threads changes shape.
            for match in re.finditer(r"(?:https?://(?:www\.)?threads\.(?:com|net))?/@[A-Za-z0-9_.]+/post/[A-Za-z0-9_-]+", value):
                push(match.group(0))
                if len(urls) >= limit:
                    break

    walk(payload)
    return urls[:limit]


def extract_relay_post_urls_from_json_texts(json_texts: List[str], limit: int) -> List[str]:
    urls: List[str] = []
    seen: Set[str] = set()
    for text in json_texts:
        if len(urls) >= limit:
            break
        if "BarcelonaSearchResultsQueryRelayPreloader" not in text and "searchResults" not in text:
            continue
        try:
            payload = json.loads(text)
        except Exception:
            continue
        for url in collect_relay_post_urls(payload, limit - len(urls)):
            if url not in seen:
                seen.add(url)
                urls.append(url)
                if len(urls) >= limit:
                    break
    return urls[:limit]


async def search_links(cdp: CDPClient, sid: str, base_url: str, keyword: str, wait_seconds: float, limit: int) -> List[str]:
    await navigate(cdp, sid, build_search_url(base_url, keyword), wait_seconds)
    js = f"""
    (() => JSON.stringify({{
      title: document.title,
      links: [...new Set([...document.querySelectorAll('a[href*=\"/post/\"], a[href*=\"/t/\"]')]
        .map(a => a.href || a.getAttribute('href') || '')
        .filter(h => h && !/\\/media(?:$|[?#])/.test(h))
        .map(h => h.startsWith('/') ? location.origin + h : h))].slice(0, {int(limit)}),
      relayJsonTexts: [...document.querySelectorAll('script[type=\"application/json\"]')]
        .map(s => s.textContent || '')
        .filter(t => t.includes('BarcelonaSearchResultsQueryRelayPreloader') || t.includes('searchResults'))
        .slice(0, 8)
    }}))()
    """
    data = await evaluate_json(cdp, sid, js) or {}
    urls: List[str] = []
    seen: Set[str] = set()
    for raw in (data.get("links") or []):
        normalized = normalize_post_url(raw)
        if normalized and normalized not in seen:
            seen.add(normalized)
            urls.append(normalized)
            if len(urls) >= limit:
                return urls
    for normalized in extract_relay_post_urls_from_json_texts(data.get("relayJsonTexts") or [], limit - len(urls)):
        if normalized and normalized not in seen:
            seen.add(normalized)
            urls.append(normalized)
            if len(urls) >= limit:
                break
    return urls[:limit]


def extract_threads_urls_from_html(html: str) -> List[str]:
    source = str(html or "")
    urls: List[str] = []
    seen: Set[str] = set()

    def push(raw: str) -> None:
        try:
            candidate = unquote(str(raw or ""))
        except Exception:
            candidate = str(raw or "")
        # Bing sometimes stores URL-safe base64-ish redirect params; direct
        # Threads URLs and DDG uddg values cover the useful cases here.
        normalized = normalize_post_url(candidate)
        if normalized and normalized not in seen:
            seen.add(normalized)
            urls.append(normalized)

    for match in re.finditer(r"uddg=([^&\"'>\s]+)", source, re.I):
        push(match.group(1))
    for match in re.finditer(r"https?://(?:www\.)?threads\.(?:com|net)/[^\"'<>\s]+", source, re.I):
        push(match.group(0))
    return urls


def build_external_queries(account: Dict[str, Any], keyword: str) -> List[str]:
    mode = str(account.get("intentMode") or "").lower()
    quoted = f'"{keyword}"' if " " in keyword else keyword
    queries = [f"site:threads.com {quoted}", f"site:threads.com {keyword}"]
    if mode == "property":
        queries += [
            f"site:threads.com {quoted} buyer rent house",
            f"site:threads.com {quoted} \"cari rumah\"",
            f"site:threads.com {quoted} \"rumah sewa\"",
        ]
    return list(dict.fromkeys(q.strip() for q in queries if q.strip()))


def external_search_links(account: Dict[str, Any], keyword: str, limit: int) -> List[str]:
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"}
    urls: List[str] = []
    seen: Set[str] = set()
    for query in build_external_queries(account, keyword):
        if len(urls) >= limit:
            break
        endpoints = [
            f"https://html.duckduckgo.com/html/?q={quote_plus(query)}",
            f"https://www.bing.com/search?q={quote_plus(query)}&first=1",
        ]
        for endpoint in endpoints:
            if len(urls) >= limit:
                break
            try:
                res = requests.get(endpoint, headers=headers, timeout=18)
                found = extract_threads_urls_from_html(res.text)
            except Exception:
                found = []
            for link in found:
                if link in seen:
                    continue
                seen.add(link)
                urls.append(link)
                if len(urls) >= limit:
                    break
            time.sleep(float(os.environ.get("LIGHTPANDA_EXTERNAL_SEARCH_DELAY", "0.6")))
    return urls


def history_seed_links(config: Dict[str, Any], account: Dict[str, Any], keyword: str, limit: int) -> List[str]:
    if not config.get("historySeedEnabled", True):
        return []
    if str(account.get("intentMode") or "").lower() != "property":
        return []
    root = Path(config.get("historySeedPath") or "/root/.hermes/dashboard/state/threads-recent-topic-flow").expanduser()
    if not root.exists():
        return []
    matches: List[Tuple[float, str]] = []
    for path in root.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        post = data.get("post") if isinstance(data, dict) else {}
        if not isinstance(post, dict):
            continue
        url = normalize_post_url(str(post.get("url") or ""))
        if not url:
            continue
        text = f"{post.get('keyword') or ''} {post.get('content') or ''}".lower()
        buyer = post.get("buyerIntent") if isinstance(post.get("buyerIntent"), dict) else {}
        if keyword.lower() not in text and not any(term in text for term in PROPERTY_INTENT):
            continue
        if buyer and buyer.get("intent") != "buyer":
            continue
        try:
            mtime = path.stat().st_mtime
        except Exception:
            mtime = 0.0
        matches.append((mtime, url))
    out: List[str] = []
    seen: Set[str] = set()
    for _, url in sorted(matches, reverse=True):
        if url not in seen:
            seen.add(url)
            out.append(url)
        if len(out) >= limit:
            break
    return out


def merge_discovery_sources(direct: List[str], external: List[str], history: List[str]) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    seen: Set[str] = set()
    for source, links in (("threads-search", direct), ("search-engine-fallback", external), ("dashboard-history-seed", history)):
        for link in links:
            normalized = normalize_post_url(link)
            if normalized and normalized not in seen:
                seen.add(normalized)
                out.append((normalized, source))
    return out


async def extract_post(cdp: CDPClient, sid: str, url: str, wait_seconds: float) -> Dict[str, Any]:
    await navigate(cdp, sid, url, wait_seconds)
    js = r'''
    (() => {
      const metas = [...document.querySelectorAll('meta')].map(m => ({
        key: m.getAttribute('property') || m.getAttribute('name') || '',
        content: m.getAttribute('content') || ''
      }));
      const pick = (name) => (metas.find(m => m.key === name)?.content || '');
      const textOf = (selector) => [...document.querySelectorAll(selector)]
        .map(el => el.innerText || el.textContent || '')
        .filter(Boolean)
        .join('\n');
      const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
      const postText = textOf('article, [role="article"]') || textOf('main, [role="main"]') || bodyText;
      return JSON.stringify({
        url: location.href,
        title: document.title || '',
        description: pick('og:description') || pick('description') || pick('twitter:description') || '',
        ogTitle: pick('og:title') || pick('twitter:title') || '',
        imageUrls: [...new Set([
          pick('og:image'), pick('twitter:image'),
          ...[...document.images].map(i => i.currentSrc || i.src || '')
        ].filter(Boolean))].slice(0, 5),
        postText,
        fullText: bodyText
      });
    })()
    '''
    data = await evaluate_json(cdp, sid, js) or {}
    data["url"] = normalize_post_url(data.get("url") or url)
    focused_text = data.get("postText") or data.get("fullText") or ""
    data["text"] = clean_post_text("\n".join(str(part or "") for part in [
        data.get("title"),
        data.get("ogTitle"),
        data.get("description"),
        focused_text,
    ]))
    data["textSource"] = "dom-post-text" if data.get("postText") else "dom-body-text"
    return data


def start_lightpanda(config: Dict[str, Any], account: Dict[str, Any], port: int, stderr_path: Path) -> subprocess.Popen:
    binary = Path(config["lightpandaBinary"]).expanduser()
    base_cookie = safe_path(account["baseCookiesPath"])
    session_cookie = safe_path(account.get("sessionCookiesPath") or account["baseCookiesPath"])
    cookie_to_load = session_cookie if session_cookie.exists() else base_cookie
    cmd = [
        str(binary), "serve",
        "--host", "127.0.0.1",
        "--port", str(port),
        "--cookie", str(cookie_to_load),
        "--cookie-jar", str(session_cookie),
        "--http-timeout", str(config.get("httpTimeoutMs", 15000)),
        "--log-level", "warn",
    ]
    env = os.environ.copy()
    env["LIGHTPANDA_DISABLE_TELEMETRY"] = "true"
    stderr_handle = stderr_path.open("w", encoding="utf-8")
    return subprocess.Popen(cmd, stdout=stderr_handle, stderr=stderr_handle, text=True, env=env)


def wait_ws(port: int, timeout: float = 10.0) -> str:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            data = requests.get(f"http://127.0.0.1:{port}/json/version", timeout=1).json()
            return data["webSocketDebuggerUrl"]
        except Exception as exc:
            last = exc
            time.sleep(0.2)
    raise RuntimeError(f"Lightpanda CDP not ready on {port}: {last}")


async def run_account(config: Dict[str, Any], config_path: Path, account: Dict[str, Any], args: argparse.Namespace, seen: Set[str], run_dir: Path) -> Dict[str, Any]:
    if not args.no_import:
        import_cookies(config_path, str(account["id"]))
    port = free_port()
    account_dir = run_dir / str(account["id"])
    account_dir.mkdir(parents=True, exist_ok=True)
    stderr_path = account_dir / "lightpanda.log"
    proc = start_lightpanda(config, account, port, stderr_path)
    samples: List[Dict[str, Any]] = []
    prev_cpu = prev_time = None
    sample_task_stop = False

    async def sampler():
        nonlocal prev_cpu, prev_time
        while not sample_task_stop and proc.poll() is None:
            sample, prev_cpu, prev_time = sample_proc(proc.pid, prev_cpu, prev_time)
            sample["elapsed"] = round(time.time() - started, 3)
            samples.append(sample)
            await asyncio.sleep(float(config.get("sampleIntervalSeconds", 0.5)))

    started = time.time()
    candidates: List[Dict[str, Any]] = []
    checked_urls: List[str] = []
    errors: List[str] = []
    selected_keywords: List[str] = []
    keyword_rotation: Dict[str, Any] = {}
    try:
        ws_url = wait_ws(port)
        task = asyncio.create_task(sampler())
        cdp, sid = await open_page(ws_url)
        try:
            selected_keywords, keyword_rotation = rotating_keyword_list(
                account,
                int(args.max_keywords or config.get("maxKeywordsPerAccount", 6)),
                advance=not bool(args.no_send),
            )
            for keyword in selected_keywords:
                if len(candidates) >= int(args.max_candidates or config.get("maxCandidatesPerAccount", 2)):
                    break
                limit = int(config.get("searchLinksPerKeyword", 8))
                direct_links: List[str] = []
                try:
                    direct_links = await search_links(cdp, sid, config.get("baseUrl", "https://www.threads.net"), keyword, float(config.get("searchWaitSeconds", 8)), limit)
                except Exception as exc:
                    errors.append(f"threads-search {keyword}: {exc}")
                external_links = external_search_links(account, keyword, limit) if len(direct_links) < limit else []
                history_links = history_seed_links(config, account, keyword, limit) if len(direct_links) + len(external_links) < limit else []
                links = merge_discovery_sources(direct_links, external_links, history_links)
                if not links:
                    errors.append(f"no links for keyword: {keyword}")
                    continue
                for link, discovery_source in links:
                    key = post_key(link)
                    if not key or key in seen or key in checked_urls:
                        continue
                    checked_urls.append(key)
                    try:
                        post = await extract_post(cdp, sid, link, float(config.get("postWaitSeconds", 6)))
                    except Exception as exc:
                        errors.append(f"post {link}: {exc}")
                        continue
                    language_decision = classify_language_with_ai(account, keyword, post, config)
                    ok, reasons, score, buyer_intent = score_candidate(account, keyword, post, config, language_decision=language_decision)
                    record = {
                        **post,
                        "keyword": keyword,
                        "key": key,
                        "score": score,
                        "reasons": reasons,
                        "language": language_decision.get("language") or post.get("language") or "",
                        "languageDecision": language_decision,
                        "candidate": ok,
                        "discoverySource": discovery_source,
                        "runId": run_dir.name,
                    }
                    if buyer_intent:
                        record["buyerIntent"] = buyer_intent
                    post_artifact_path = account_dir / f"post-{len(checked_urls):02d}.json"
                    write_json(post_artifact_path, record)
                    if ok:
                        msg = format_candidate(config, account, record)
                        rich_msg = format_candidate_rich(config, account, record)
                        buttons: List[Dict[str, str]] = []
                        action_state: Optional[Dict[str, Any]] = None
                        action_state_path: Optional[Path] = None
                        if config.get("telegramButtonsEnabled", True):
                            action_state = build_threads_action_state(config, account, record)
                            auto_settings = action_state.get("commentSettings") or {}
                            should_auto_comment = bool(auto_settings.get("autoCommentEnabled") and auto_settings.get("commentSubmitEnabled"))
                            buttons = [] if should_auto_comment else build_telegram_buttons(str(action_state["id"]))
                            if not args.no_send:
                                action_state_path = write_threads_action_state(config, action_state)
                        send_result = send_telegram(config, msg, dry_run=bool(args.no_send), buttons=buttons, rich_text=rich_msg)
                        if action_state:
                            message_id = send_result.get("messageId")
                            record["telegramAction"] = {
                                "stateId": action_state.get("id"),
                                "shortId": action_state.get("shortId"),
                                "statePath": str(action_state_path) if action_state_path else "dry-run/not-written",
                                "buttonLabels": [button.get("label") for button in buttons],
                            }
                            if message_id and not args.no_send:
                                action_state["previewMessageIds"] = [message_id]
                                action_state["updatedAt"] = iso_timestamp()
                                write_threads_action_state(config, action_state)
                            auto_settings = action_state.get("commentSettings") or {}
                            if bool(auto_settings.get("autoCommentEnabled") and auto_settings.get("commentSubmitEnabled")):
                                auto_result = trigger_auto_comment_for_state(action_state, dry_run=bool(args.no_send))
                                record["autoComment"] = auto_result
                                action_state["autoCommentTriggeredAt"] = iso_timestamp()
                                action_state["autoCommentResult"] = auto_result
                                action_state["updatedAt"] = iso_timestamp()
                                if not args.no_send:
                                    write_threads_action_state(config, action_state)
                        record["telegram"] = send_result
                        write_json(post_artifact_path, record)
                        candidates.append(record)
                        if config.get("markSeenOnSend", True) and not args.no_send:
                            seen.add(key)
                            write_seen(seen)
                        if len(candidates) >= int(args.max_candidates or config.get("maxCandidatesPerAccount", 2)):
                            break
        finally:
            await cdp.__aexit__(None, None, None)
            sample_task_stop = True
            await asyncio.sleep(0)
            if not task.done():
                task.cancel()
    finally:
        sample_task_stop = True
        try:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    duration = time.time() - started
    result = {
        "browserSource": config.get("browserSource", "PandaBrowser/Lightpanda"),
        "mode": "finder",
        "runId": run_dir.name,
        "startedAt": time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(started)),
        "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "durationSeconds": round(duration, 2),
        "accountId": account.get("id"),
        "accountLabel": account.get("label"),
        "intentMode": account.get("intentMode"),
        "selectedKeywords": selected_keywords,
        "keywordRotation": keyword_rotation,
        "exitCode": proc.returncode,
        "resource": summarize_samples(samples),
        "candidateCount": len(candidates),
        "checkedPostCount": len(checked_urls),
        "candidates": candidates,
        "errors": errors[-10:],
        "runDir": str(account_dir),
        "safety": {
            "isolatedLightpandaOnly": True,
            "noDashboardMutation": True,
            "noNodePatchrightMutation": True,
            "sourceStorageStateReadOnly": True,
            "realScreenshotAvailable": False,
            "screenshotNote": "Lightpanda Page.captureScreenshot returns a built-in fake PNG in this version; this runner uses DOM/meta/image evidence instead.",
            "autoCommentSubmit": bool(effective_auto_comment(config, account).get("enabled") and effective_auto_comment(config, account).get("submit")),
            "telegramButtonsEnabled": bool(config.get("telegramButtonsEnabled", True)),
            "telegramActionStateDir": str(telegram_action_state_dir(config)),
        },
    }
    write_json(account_dir / "result.json", result)
    return result


async def amain() -> int:
    parser = argparse.ArgumentParser(description="Run standalone Lightpanda Threads finder")
    parser.add_argument("--config", default=str(CONFIG_PATH))
    parser.add_argument("--account", help="Run one account id only")
    parser.add_argument("--all", action="store_true", help="Run all enabled accounts")
    parser.add_argument("--max-keywords", type=int)
    parser.add_argument("--max-candidates", type=int)
    parser.add_argument("--no-import", action="store_true")
    parser.add_argument("--no-send", action="store_true", help="Dry-run: do not send Telegram and do not mark seen")
    args = parser.parse_args()

    config_path = Path(args.config).expanduser()
    config = load_json(config_path)
    if not config:
        raise SystemExit(f"Missing config: {config_path}")
    if sqlite_record_config is not None:
        try:
            sqlite_record_config(config, SQLITE_DB_PATH)
        except Exception:
            pass
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_id = time.strftime("%Y%m%d-%H%M%S") + f"-finder-{random.randint(10000,99999)}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    accounts = [a for a in config.get("accounts", []) if a.get("enabled", True)]
    if args.account:
        accounts = [a for a in accounts if a.get("id") == args.account]
    if not accounts:
        raise SystemExit("No enabled Lightpanda accounts selected")

    seen = read_seen()
    seen.update(dashboard_state_seen_keys(config))
    results = []
    for account in accounts:
        results.append(await run_account(config, config_path, account, args, seen, run_dir))

    final = {
        "browserSource": config.get("browserSource", "PandaBrowser/Lightpanda"),
        "mode": "finder-summary",
        "runId": run_id,
        "startedAt": results[0]["startedAt"] if results else time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "accountCount": len(results),
        "candidateCount": sum(int(r.get("candidateCount") or 0) for r in results),
        "checkedPostCount": sum(int(r.get("checkedPostCount") or 0) for r in results),
        "results": results,
        "resource": {
            "peakPssMb": round(sum(float(r.get("resource", {}).get("peakPssMb") or 0) for r in results), 1),
            "peakRssMb": round(sum(float(r.get("resource", {}).get("peakRssMb") or 0) for r in results), 1),
            "peakCpuPercent": round(max([float(r.get("resource", {}).get("peakCpuPercent") or 0) for r in results] or [0]), 1),
            "peakProcessCount": max([int(r.get("resource", {}).get("peakProcessCount") or 0) for r in results] or [0]),
        },
        "runDir": str(run_dir),
        "safety": config.get("safety", {}),
    }
    write_json(run_dir / "summary.json", final)
    write_json(STATUS_PATH, final)
    append_jsonl(HISTORY_PATH, final)
    if sqlite_record_run_summary is not None:
        try:
            sqlite_record_run_summary(final, SQLITE_DB_PATH)
        except Exception:
            pass
    print(json.dumps(final, indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    return asyncio.run(amain())


if __name__ == "__main__":
    raise SystemExit(main())
