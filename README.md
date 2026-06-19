# ThreadLeadAutomation

Lightpanda + Hermes dashboard automation for Threads lead discovery and Telegram review.

## What is included

- `dashboard/` — Next.js dashboard and Telegram callback API used for account controls and review cards.
- `lightpanda-threads/` — Lightpanda Threads finder, monitor, tests, and config templates.
- `scripts/lightpanda_threads_cron.py` — Hermes cron wrapper script.
- `docs/` — operational notes and patches needed outside this repo.

## What is intentionally excluded

This repo is sanitized. It does **not** include local runtime secrets or private state:

- `.env`, Telegram bot token, GitHub token, Hermes `auth.json`
- Threads storage state / cookies
- SQLite databases, session state, logs, screenshots, build output
- `node_modules`, `.next`, Lightpanda binary cache

## Current local cron

The local Hermes cron job was paused before this push:

```text
Lightpanda Threads Finder
schedule: every 30m
state: paused
enabled: false
```

## Setup sketch on a new machine

1. Install Node.js, Python 3.11+, Hermes Agent, GitHub CLI, and Lightpanda.
2. Restore local secrets into `.env` / Hermes config locally, not in git.
3. Put Threads auth/storage files under local `state/auth` or update the config paths.
4. Install dashboard dependencies:

```bash
cd dashboard
npm install
npm run build
```

5. Run/restore the Hermes cron using `scripts/lightpanda_threads_cron.py`.

## Important note: Telegram “Me” button

The live server also has a Hermes Telegram gateway patch so the **Me** button consumes the next Telegram topic message and runs:

```text
comment-custom --force-submit=true
```

See `docs/hermes-telegram-gateway-manual-reply-patch.md` for details.
