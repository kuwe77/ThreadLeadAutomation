#!/usr/bin/env python3
"""Run isolated Lightpanda Threads probes and record resource usage.

This is intentionally fetch-only. It does not interact with existing Node.js,
Patchright, or the live Next dashboard service.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import quote_plus

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.json"
STATE_DIR = ROOT / "state"
RUNS_DIR = STATE_DIR / "runs"
STATUS_PATH = STATE_DIR / "status.json"
HISTORY_PATH = STATE_DIR / "runs.jsonl"
IMPORT_SCRIPT = ROOT / "scripts" / "import_cookies.py"
HZ = os.sysconf(os.sysconf_names["SC_CLK_TCK"])


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any, private: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    if private:
        os.chmod(tmp, 0o600)
    tmp.replace(path)
    if private:
        os.chmod(path, 0o600)


def append_jsonl(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def read_cmdline(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except Exception:
        return ""


def proc_stat(pid: int) -> Optional[List[str]]:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].strip().split()
    except Exception:
        return None


def proc_ppid(pid: int) -> Optional[int]:
    stat = proc_stat(pid)
    return int(stat[1]) if stat else None


def proc_cpu_seconds(pid: int) -> float:
    stat = proc_stat(pid)
    if not stat:
        return 0.0
    return (int(stat[11]) + int(stat[12])) / HZ


def proc_mem(pid: int) -> Dict[str, float]:
    out = {"rss_mb": 0.0, "pss_mb": 0.0, "private_mb": 0.0, "shared_mb": 0.0}
    status = Path(f"/proc/{pid}/status")
    try:
        for line in status.read_text().splitlines():
            if line.startswith("VmRSS:"):
                out["rss_mb"] = int(line.split()[1]) / 1024.0
                break
    except Exception:
        pass

    rollup = Path(f"/proc/{pid}/smaps_rollup")
    vals: Dict[str, int] = {}
    try:
        for line in rollup.read_text().splitlines():
            parts = line.split()
            if len(parts) >= 2:
                vals[parts[0].rstrip(":")] = int(parts[1])
    except Exception:
        # Some short-lived processes disappear between /status and smaps_rollup
        # reads. For Lightpanda this is usually one process, so RSS is the
        # safest fallback rather than reporting misleading zero PSS.
        out["pss_mb"] = out["rss_mb"]
        out["private_mb"] = out["rss_mb"]
        return out

    out["pss_mb"] = vals.get("Pss", 0) / 1024.0
    out["private_mb"] = (vals.get("Private_Clean", 0) + vals.get("Private_Dirty", 0)) / 1024.0
    out["shared_mb"] = (vals.get("Shared_Clean", 0) + vals.get("Shared_Dirty", 0)) / 1024.0
    if out["pss_mb"] <= 0 and out["rss_mb"] > 0:
        out["pss_mb"] = out["rss_mb"]
        out["private_mb"] = max(out["private_mb"], out["rss_mb"])
    return out


def process_tree(root: int) -> Set[int]:
    pids = [int(item) for item in os.listdir("/proc") if item.isdigit()]
    children: Dict[int, List[int]] = {}
    for pid in pids:
        ppid = proc_ppid(pid)
        if ppid is not None:
            children.setdefault(ppid, []).append(pid)

    seen: Set[int] = set()
    stack = [root]
    while stack:
        pid = stack.pop()
        if pid in seen or not Path(f"/proc/{pid}").exists():
            continue
        seen.add(pid)
        stack.extend(children.get(pid, []))
    return seen


def sample_tree(root: int, prev_cpu: Optional[float], prev_time: Optional[float]) -> Tuple[Dict[str, Any], float, float]:
    now = time.time()
    tree = process_tree(root)
    cpu_total = sum(proc_cpu_seconds(pid) for pid in tree)
    mems = [proc_mem(pid) for pid in tree]
    rss = sum(item["rss_mb"] for item in mems)
    pss = sum(item["pss_mb"] for item in mems)
    private = sum(item["private_mb"] for item in mems)
    shared = sum(item["shared_mb"] for item in mems)
    cpu_pct = None
    if prev_cpu is not None and prev_time is not None:
        cpu_pct = max(0.0, (cpu_total - prev_cpu) / max(now - prev_time, 1e-6) * 100.0)
    return (
        {
            "t": now,
            "pidCount": len(tree),
            "rssMb": rss,
            "pssMb": pss,
            "privateMb": private,
            "sharedMb": shared,
            "cpuPercent": cpu_pct,
        },
        cpu_total,
        now,
    )


def summarize_samples(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    cpus = [s["cpuPercent"] for s in samples if s.get("cpuPercent") is not None]
    def avg(key: str) -> float:
        vals = [float(s.get(key) or 0.0) for s in samples]
        return sum(vals) / len(vals) if vals else 0.0
    def peak(key: str) -> float:
        vals = [float(s.get(key) or 0.0) for s in samples]
        return max(vals) if vals else 0.0
    return {
        "samples": len(samples),
        "peakRssMb": round(peak("rssMb"), 1),
        "avgRssMb": round(avg("rssMb"), 1),
        "peakPssMb": round(peak("pssMb"), 1),
        "avgPssMb": round(avg("pssMb"), 1),
        "peakPrivateMb": round(peak("privateMb"), 1),
        "avgPrivateMb": round(avg("privateMb"), 1),
        "peakCpuPercent": round(max(cpus), 1) if cpus else 0.0,
        "avgCpuPercent": round(sum(cpus) / len(cpus), 1) if cpus else 0.0,
        "peakProcessCount": max((int(s.get("pidCount") or 0) for s in samples), default=0),
    }


def import_cookies(config_path: Path, account_id: str) -> None:
    cmd = [sys.executable, str(IMPORT_SCRIPT), "--config", str(config_path), "--account", account_id]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def find_account(config: Dict[str, Any], account_id: str) -> Dict[str, Any]:
    for account in config.get("accounts", []):
        if account.get("id") == account_id:
            return account
    raise SystemExit(f"Account not found in config: {account_id}")


def enabled_accounts(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [account for account in config.get("accounts", []) if account.get("enabled", True)]


def select_keywords(account: Dict[str, Any], max_keywords: int, override: Optional[str]) -> List[str]:
    if override:
        return [override]
    keywords = [str(item).strip() for item in account.get("keywords", []) if str(item).strip()]
    if max_keywords > 0:
        keywords = keywords[:max_keywords]
    return keywords or [""]


def build_search_url(base_url: str, keyword: str) -> str:
    if keyword:
        return f"{base_url.rstrip('/')}/search?q={quote_plus(keyword)}&serp_type=default"
    return base_url.rstrip("/") + "/"


def analyze_content(content: str, account: Dict[str, Any]) -> Dict[str, Any]:
    lower = content.lower()
    handle = str(account.get("handle") or "").lower().lstrip("@")
    post_links = re.findall(r"(?:https://www\.threads\.net)?/@[A-Za-z0-9_.]+/post/[A-Za-z0-9_-]+", content)
    return {
        "contentLength": len(content),
        "containsAccountHandle": bool(handle and handle in lower),
        "loginHint": any(token in lower for token in ["log in", "login", "sign up", "continue with instagram"]),
        "postLinkCount": len(set(post_links)),
        "samplePostLinks": sorted(set(post_links))[:5],
        "titleHint": (re.search(r"<title[^>]*>(.*?)</title>", content, re.I | re.S).group(1).strip() if re.search(r"<title[^>]*>(.*?)</title>", content, re.I | re.S) else ""),
    }


def run_one(config: Dict[str, Any], config_path: Path, account: Dict[str, Any], keyword: str, args: argparse.Namespace) -> Dict[str, Any]:
    if not args.no_import:
        import_cookies(config_path, str(account["id"]))

    cookies_path = Path(account["cookiesPath"])
    if not cookies_path.is_absolute():
        cookies_path = ROOT / cookies_path

    lightpanda = Path(config["lightpandaBinary"]).expanduser()
    run_id = time.strftime("%Y%m%d-%H%M%S") + f"-{account['id']}-{abs(hash(keyword)) % 100000:05d}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    url = build_search_url(config.get("baseUrl", "https://www.threads.net"), keyword)
    wait_ms = int(args.wait_ms or config.get("waitMs", 12000))
    dump_mode = args.dump or config.get("dump", "html")
    terminate_ms = int(args.terminate_ms or config.get("terminateMs", max(wait_ms + 8000, 20000)))

    cmd = [
        str(lightpanda),
        "fetch",
        "--cookie",
        str(cookies_path),
        "--dump",
        dump_mode,
        "--json",
        "--wait-ms",
        str(wait_ms),
        "--terminate-ms",
        str(terminate_ms),
        "--http-timeout",
        str(config.get("httpTimeoutMs", 15000)),
        "--log-level",
        str(config.get("logLevel", "warn")),
        url,
    ]

    env = os.environ.copy()
    env["LIGHTPANDA_DISABLE_TELEMETRY"] = "true"
    stdout_path = run_dir / "stdout.json"
    stderr_path = run_dir / "stderr.log"
    started = time.time()
    killed_for_timeout = False
    hard_deadline = started + (terminate_ms / 1000.0) + 15.0

    # Write directly to files. Threads can dump a large HTML payload; using PIPE
    # can deadlock if the child fills the pipe while this parent is sampling RAM.
    with stdout_path.open("w", encoding="utf-8") as stdout_handle, stderr_path.open("w", encoding="utf-8") as stderr_handle:
        proc = subprocess.Popen(cmd, stdout=stdout_handle, stderr=stderr_handle, text=True, env=env)

        samples: List[Dict[str, Any]] = []
        prev_cpu: Optional[float] = None
        prev_time: Optional[float] = None
        while proc.poll() is None:
            sample, prev_cpu, prev_time = sample_tree(proc.pid, prev_cpu, prev_time)
            sample["elapsed"] = round(time.time() - started, 3)
            samples.append(sample)
            if time.time() > hard_deadline:
                killed_for_timeout = True
                proc.kill()
                break
            time.sleep(float(config.get("sampleIntervalSeconds", 0.5)))
        proc.wait(timeout=5)

    stdout = stdout_path.read_text(encoding="utf-8", errors="replace")
    stderr = stderr_path.read_text(encoding="utf-8", errors="replace")
    # One final sample may fail if process already disappeared; that is okay.
    duration = time.time() - started
    write_json(run_dir / "samples.json", samples)

    payload: Dict[str, Any] = {}
    content = ""
    parse_error = None
    try:
        payload = json.loads(stdout) if stdout.strip() else {}
        content = str(payload.get("content") or "")
        (run_dir / f"content.{dump_mode if dump_mode != 'semantic_tree_text' else 'txt'}").write_text(content, encoding="utf-8")
    except Exception as exc:  # keep full stdout for debugging
        parse_error = repr(exc)

    result = {
        "browserSource": "PandaBrowser/Lightpanda",
        "runId": run_id,
        "startedAt": time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(started)),
        "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "durationSeconds": round(duration, 2),
        "accountId": account.get("id"),
        "accountLabel": account.get("label"),
        "keyword": keyword,
        "url": url,
        "exitCode": proc.returncode,
        "killedForTimeout": killed_for_timeout,
        "httpStatus": payload.get("http_status") if isinstance(payload, dict) else None,
        "resource": summarize_samples(samples),
        "analysis": analyze_content(content, account) if content else {},
        "parseError": parse_error,
        "stderrTail": stderr[-1200:],
        "runDir": str(run_dir),
        "safety": {"fetchOnly": True, "noPosting": True, "originalStorageStateReadOnly": True},
    }
    write_json(run_dir / "result.json", result)
    write_json(STATUS_PATH, result)
    append_jsonl(HISTORY_PATH, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Lightpanda Threads fetch-only probe")
    parser.add_argument("--config", default=str(CONFIG_PATH))
    parser.add_argument("--account", help="Account id to run; defaults to first enabled account")
    parser.add_argument("--all", action="store_true", help="Run all enabled accounts sequentially")
    parser.add_argument("--keyword", help="Override keyword for this probe")
    parser.add_argument("--max-keywords", type=int, default=1, help="Keywords per account; 1 by default for safe spike")
    parser.add_argument("--wait-ms", type=int)
    parser.add_argument("--terminate-ms", type=int)
    parser.add_argument("--dump", choices=["html", "markdown", "semantic_tree", "semantic_tree_text"])
    parser.add_argument("--no-import", action="store_true", help="Use existing Lightpanda cookie file without re-import")
    args = parser.parse_args()

    config_path = Path(args.config).expanduser()
    config = load_json(config_path)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    accounts = enabled_accounts(config) if args.all else [find_account(config, args.account or enabled_accounts(config)[0]["id"])]
    results = []
    for account in accounts:
        for keyword in select_keywords(account, args.max_keywords, args.keyword):
            results.append(run_one(config, config_path, account, keyword, args))

    final = {"count": len(results), "results": results}
    print(json.dumps(final, indent=2, ensure_ascii=False))
    return 0 if all(item.get("exitCode") == 0 for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
