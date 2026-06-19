# Hermes Telegram gateway manual reply patch

The local server was patched outside `/root/.hermes` at:

```text
/usr/local/lib/hermes-agent/gateway/platforms/telegram.py
```

Reason: Telegram inline buttons are handled by the Hermes Telegram gateway, not only by the dashboard API route.

## Behaviors fixed

- **Lily** button now spawns the Threads comment runner with `--force-submit=true` so a human-approved Lily click can post even when account auto-submit is OFF.
- **Me** button now stores `awaiting_manual_reply`, then the next text message from the same user/chat/topic is consumed and posted with:

```text
comment-custom --job-id=<job> --reply=<user text> --force-submit=true
```

- The next text message is not sent to normal Hermes chat when it is a pending Threads manual reply.

## Relevant functions added/changed

- `_handle_threads_recent_callback(...)`
  - For `action == "auto"`, calls:
    ```python
    self._spawn_threads_recent_script(["comment-auto", f"--job-id={state.get('id') or job_id}", "--force-submit=true"])
    ```
- `_consume_pending_threads_manual_reply(...)`
- `_handle_pending_threads_manual_reply_text(...)`
- `_handle_text_message(...)`
  - Calls `_handle_pending_threads_manual_reply_text(msg)` before normal message enqueue.

## Restart required

After applying this patch, restart the Hermes gateway:

```bash
systemctl --user restart hermes-gateway.service
```

If it hangs because the gateway is currently handling a Telegram turn, use a delayed restart or force-kill/start sequence.
