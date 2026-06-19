# Lightpanda Threads Spike

Isolated Lightpanda experiment for Threads monitoring.

## Safety boundaries

- Does **not** modify the existing Hermes dashboard (`:5001`).
- Does **not** modify existing Node.js / Patchright Threads scripts.
- Does **not** write back to the original Playwright storage-state files.
- Imports cookies into a separate Lightpanda cookie JSON under `state/cookies/`.
- Fetch-only: no commenting, no posting, no Telegram send.

## Main files

- `config.json` — isolated Lightpanda config.
- `scripts/import_cookies.py` — converts Playwright storage-state cookies to Lightpanda's cookie-array format.
- `scripts/run_threads_lightpanda.py` — runs a Lightpanda Threads fetch/probe and records CPU/RAM.
- `scripts/serve_monitor.py` — standalone local monitoring dashboard server.
- `monitor/index.html` — browser UI for Lightpanda status.

## Quick commands

```bash
cd ~/.hermes/lightpanda-threads
python3 scripts/import_cookies.py
python3 scripts/run_threads_lightpanda.py --account threads-1 --max-keywords 1
python3 scripts/serve_monitor.py --host 127.0.0.1 --port 5057
```

Dashboard URL:

```text
http://127.0.0.1:5057/
```

## Notes

Lightpanda cookie files contain real auth cookie values. Keep `state/cookies/*.json` private and never paste them into chat/logs.
