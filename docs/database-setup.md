# Database setup for another agent / another PC

This repo intentionally does **not** include the live SQLite database file:

```text
lightpanda-threads/state/lightpanda_threads.db
```

That file is local runtime state. It contains run history, seen posts, candidates, and Telegram action state. It is safe and expected for another machine/agent to create a fresh database.

## Short answer

A new agent should create the DB by running:

```bash
cd lightpanda-threads
mkdir -p state
python3 scripts/sqlite_store.py init
python3 scripts/sqlite_store.py migrate
python3 scripts/sqlite_store.py stats
```

Expected result:

```json
{
  "ok": true,
  "db": ".../lightpanda-threads/state/lightpanda_threads.db"
}
```

After this, the repo has a working SQLite database with the required schema.

## What the DB stores

The SQLite schema is created automatically by `scripts/sqlite_store.py`. It creates these tables:

| Table | Purpose |
|---|---|
| `settings` | Stores the effective finder config JSON. |
| `accounts` | Stores account definitions, handles, keywords, paths, and controls. |
| `runs` | One row per finder/cron run summary. |
| `run_accounts` | Per-account result summary for each run. |
| `candidates` | Threads posts/candidates found by the finder. |
| `seen_posts` | Deduplication store so the same post is not repeatedly sent. |
| `telegram_actions` | Telegram review/action cards and comment status. |
| `cron_state` | Small key/value runtime state for cron. |
| `event_logs` | Optional runtime events/logging. |

## Fresh setup from clone

From a clean clone:

```bash
git clone https://github.com/kuwe77/ThreadLeadAutomation.git
cd ThreadLeadAutomation
```

Install dashboard dependencies:

```bash
cd dashboard
npm install
npm run build
cd ..
```

Create runtime directories:

```bash
mkdir -p lightpanda-threads/state/cookies
mkdir -p dashboard/state/auth
mkdir -p dashboard/state/threads-recent-topic-flow
```

Create the SQLite database:

```bash
cd lightpanda-threads
python3 scripts/sqlite_store.py init
python3 scripts/sqlite_store.py migrate
python3 scripts/sqlite_store.py stats
cd ..
```

## What `migrate` does

`python3 scripts/sqlite_store.py migrate` is safe to run on a new machine.

It will:

1. Read `lightpanda-threads/finder_config.json`.
2. Insert/update the `settings` and `accounts` tables.
3. If local JSON runtime files exist, import them too:
   - `state/seen-posts.json`
   - `state/runs.jsonl`
   - `state/status.json`
   - `state/cron-last-summary.json`
   - `../dashboard/state/threads-recent-topic-flow/thrrec_*.json`
4. If those files do not exist, it simply creates the database and imports config/account rows.

If the dashboard action state lives somewhere else, set:

```bash
export THREADS_ACTION_STATE_DIR=/absolute/path/to/dashboard/state/threads-recent-topic-flow
```

## Important: path assumptions

Some files currently assume the same Hermes layout used on the original server:

```text
/root/.hermes/dashboard
/root/.hermes/lightpanda-threads
```

Best/easiest option for the other PC agent:

```bash
mkdir -p /root/.hermes
ln -sfn /path/to/ThreadLeadAutomation/dashboard /root/.hermes/dashboard
ln -sfn /path/to/ThreadLeadAutomation/lightpanda-threads /root/.hermes/lightpanda-threads
```

Or, if the machine uses another home path, update these config paths manually:

- `lightpanda-threads/finder_config.json`
- `lightpanda-threads/config.json`
- dashboard API constants in `dashboard/app/api/lightpanda-threads/settings/route.ts` if needed

## Auth/cookies are still required

The DB only stores structured automation state. It does **not** log into Threads.

The other agent must provide local auth files/cookies, for example:

```text
dashboard/state/auth/cms-threads-koiiss_.json
lightpanda-threads/state/cookies/threads-1.lightpanda.cookies.json
lightpanda-threads/state/cookies/threads-1.lightpanda.session.cookies.json
```

These files are secrets and are intentionally excluded from git.

If the other PC has no cookies/storage state yet, the agent must login/import cookies locally before the finder can browse Threads as the account.

## How to verify DB works

Run:

```bash
cd lightpanda-threads
python3 scripts/sqlite_store.py stats
```

A fresh DB should show counts such as:

```json
{
  "accounts": 4,
  "runs": 0,
  "run_accounts": 0,
  "candidates": 0,
  "seen_posts": 0,
  "telegram_actions": 0
}
```

After the finder runs, `runs`, `candidates`, `seen_posts`, and `telegram_actions` should increase.

## How the finder uses it

The finder imports `scripts/sqlite_store.py` and records run summaries/action states. If the DB file is missing, `sqlite_store.connect()` creates it automatically.

So the DB does not need to be copied from the original machine. It can be recreated from code.

## Recommended instruction for another agent

Give the other agent this exact task:

> Clone `https://github.com/kuwe77/ThreadLeadAutomation`. Read `README.md`, `docs/database-setup.md`, and `docs/hermes-telegram-gateway-manual-reply-patch.md`. Create the local runtime state directories, initialize the SQLite database using `python3 lightpanda-threads/scripts/sqlite_store.py init`, run `migrate`, then configure local Threads auth/cookies and Telegram/Hermes secrets outside git. Do not commit `.env`, cookies, auth JSON, DB files, logs, or state directories.
