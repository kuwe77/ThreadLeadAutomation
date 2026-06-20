# Windows terminal login for Threads cookies

Use this when the automation runs on a VPS but the human needs to login from a Windows laptop.

This avoids manual cookie export extensions. The VPS serves a one-time Node.js/Playwright script. The Windows laptop runs it, a browser opens, the user logs in, then the script uploads Playwright `storageState` back to the VPS. The VPS stores both:

- dashboard/Patchright storage state
- Lightpanda cookie jars

## Files involved

| File | Purpose |
|---|---|
| `lightpanda-threads/scripts/threads_cookie_receiver.py` | One-time HTTP receiver on the VPS. Serves the Windows script and accepts cookie upload. |
| `lightpanda-threads/scripts/store_uploaded_cookies.py` | Converts uploaded Cookie-Editor/Playwright JSON into Playwright storage state and Lightpanda cookies. |
| `lightpanda-threads/scripts/import_cookies.py` | Converts Playwright storage state to Lightpanda cookie-array JSON. |

## VPS: start receiver

Example for account 2:

```bash
cd /root/.hermes/lightpanda-threads
python3 scripts/threads_cookie_receiver.py \
  --host 0.0.0.0 \
  --port 8765 \
  --account threads-2 \
  --public-base http://100.68.77.125:8765
```

The receiver prints a `scriptUrl`, for example:

```text
http://100.68.77.125:8765/windows-login.js?token=<one-time-token>
```

Keep the receiver running until the upload finishes. Stop it after the upload.

## Windows laptop: run PowerShell command

Give the user a PowerShell command like this, replacing the URL with the generated `scriptUrl`:

```powershell
mkdir threads-login; cd threads-login; Invoke-WebRequest "http://100.68.77.125:8765/windows-login.js?token=<one-time-token>" -OutFile threads-login.js; npm init -y; npm install playwright; npx playwright install chromium; node .\threads-login.js
```

The script will:

1. Install/use Playwright.
2. Open Chromium on the Windows laptop.
3. Navigate to Threads login.
4. Wait for the user to login and press Enter in PowerShell.
5. Upload cookies/storage state to the VPS.

## VPS output/storage

For `threads-2`, expected files:

```text
/root/.hermes/dashboard/state/auth/cms-threads-account-2.json
/root/.hermes/lightpanda-threads/state/cookies/threads-2.lightpanda.cookies.json
/root/.hermes/lightpanda-threads/state/cookies/threads-2.lightpanda.session.cookies.json
```

All should be mode `600`.

Verify without printing cookie values:

```bash
python3 - <<'PY'
import json, pathlib
for p in [
 '/root/.hermes/dashboard/state/auth/cms-threads-account-2.json',
 '/root/.hermes/lightpanda-threads/state/cookies/threads-2.lightpanda.cookies.json',
 '/root/.hermes/lightpanda-threads/state/cookies/threads-2.lightpanda.session.cookies.json',
]:
    data=json.load(open(p))
    cookies=data.get('cookies', data) if isinstance(data, dict) else data
    domains={}
    for c in cookies:
        domains[c.get('domain','')]=domains.get(c.get('domain',''),0)+1
    print(pathlib.Path(p).name, len(cookies), domains)
PY
```

## Security rules

- Never commit uploaded cookie files or storage state.
- Never print cookie values.
- Stop the receiver after upload.
- Treat the generated token URL as temporary secret material.

## Notes

- `store_uploaded_cookies.py` supports both Playwright storage state (`{"cookies": [...]}`) and raw cookie-array exports (`[{...}]`).
- `import_cookies.py --account <id>` imports even when the account is disabled, because disabled only means cron/search off; login setup must still work.
