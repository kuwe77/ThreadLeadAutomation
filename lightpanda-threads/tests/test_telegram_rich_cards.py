import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "lightpanda_threads_finder.py"
spec = importlib.util.spec_from_file_location("lightpanda_threads_finder", SCRIPT)
finder = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(finder)


class FakeResponse:
    def __init__(self, ok=True, status_code=200, payload=None, text=""):
        self.ok = ok
        self.status_code = status_code
        self._payload = payload or {"ok": True, "result": {"message_id": 99}}
        self.text = text or ""

    def json(self):
        return self._payload


def base_config():
    return {
        "dashboardSettingsPath": "/tmp/nonexistent-lightpanda-settings.json",
        "telegramChatId": "12345",
        "telegramThreadId": 678,
        "sendTelegram": True,
        "browserSource": "PandaBrowser/Lightpanda",
    }


def test_lightpanda_formats_rich_candidate_card_with_browser_and_buyer_context():
    rich = finder.format_candidate_rich(
        base_config(),
        {"id": "threads-1", "label": "@koiisss_", "replyDraftTemplate": "Boleh saya bantu shortlist."},
        {
            "keyword": "cari rumah",
            "discoverySource": "threads-search",
            "textSource": "full-post-context",
            "score": 12,
            "reasons": ["keyword match", "buyer intent accepted"],
            "text": "Saya nak beli rumah area Gombak untuk family.",
            "url": "https://www.threads.com/@lead/post/ABC123",
            "languageDecision": {"language": "mixed", "allowed": True},
            "buyerIntent": {
                "intent": "buyer",
                "confidence": 0.84,
                "reason": "Author clearly asks to buy a house for family.",
                "buyerSignals": ["nak beli rumah"],
                "sellerSignals": [],
            },
        },
    )

    assert rich.startswith("# 🔎 Threads candidate found")
    assert "**Source:** PandaBrowser/Lightpanda" in rich
    assert "**Account:** @koiisss_" in rich
    assert "**Buyer intent:** buyer (0.84)" in rich
    assert "## Post read by Lightpanda" in rich
    assert "Saya nak beli rumah area Gombak" in rich


def test_send_telegram_uses_send_rich_message_when_rich_text_is_available(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "TEST_TOKEN")
    calls = []

    def fake_post(url, json, timeout):
        calls.append({"url": url, "json": json, "timeout": timeout})
        return FakeResponse(payload={"ok": True, "result": {"message_id": 321}})

    monkeypatch.setattr(finder.requests, "post", fake_post)

    result = finder.send_telegram(
        base_config(),
        "Plain fallback",
        rich_text="# Rich card",
        buttons=[{"label": "Open", "value": "threads_recent:auto:abc"}],
    )

    assert result["ok"] is True
    assert result["messageId"] == 321
    assert result["richMessage"] is True
    assert len(calls) == 1
    assert calls[0]["url"].endswith("/sendRichMessage")
    assert calls[0]["json"] == {
        "chat_id": "12345",
        "rich_message": {"text": "# Rich card"},
        "message_thread_id": 678,
        "reply_markup": {"inline_keyboard": [[{"text": "Open", "callback_data": "threads_recent:auto:abc"}]]},
    }


def test_send_telegram_falls_back_to_classic_send_message_when_rich_fails(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "TEST_TOKEN")
    calls = []

    def fake_post(url, json, timeout):
        calls.append({"url": url, "json": json, "timeout": timeout})
        if url.endswith("/sendRichMessage"):
            return FakeResponse(False, 400, {"ok": False, "description": "Bad Request: method not found"}, "method not found")
        return FakeResponse(payload={"ok": True, "result": {"message_id": 654}})

    monkeypatch.setattr(finder.requests, "post", fake_post)

    result = finder.send_telegram(base_config(), "Plain fallback", rich_text="# Rich card")

    assert result["ok"] is True
    assert result["messageId"] == 654
    assert result["richMessage"] is False
    assert result["richFallback"] is True
    assert "method not found" in result["richError"]
    assert len(calls) == 2
    assert calls[0]["url"].endswith("/sendRichMessage")
    assert calls[1]["url"].endswith("/sendMessage")
    assert calls[1]["json"] == {
        "chat_id": "12345",
        "text": "Plain fallback",
        "disable_web_page_preview": False,
        "message_thread_id": 678,
    }
