import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "lightpanda_threads_finder.py"
spec = importlib.util.spec_from_file_location("lightpanda_threads_finder", SCRIPT)
finder = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(finder)

AUTOMATION_ACCOUNT = {
    "intentMode": "automation",
    "keywords": ["n8n", "belajar n8n", "kelas n8n", "n8n malaysia"],
}


def score(text: str):
    post = {"title": text, "description": text, "text": text}
    return finder.score_candidate(AUTOMATION_ACCOUNT, "belajar n8n", post, {})


def test_indonesian_where_to_start_n8n_post_is_rejected():
    ok, reasons, score_value, _ = score("Halo warga threads, belajar n8n baiknya mulai darimana ya ?")
    assert ok is False
    assert score_value < 4
    assert any("Indonesian/non-target" in reason for reason in reasons)


def test_indonesian_javanese_style_n8n_post_is_rejected():
    ok, reasons, score_value, _ = score(
        "Keren pak. Pak ijin tanya. ada cara termudah belajar n8n kah? Saya ndak ada background IT sama sekali. Ndak mudeng dengan flow di n8n."
    )
    assert ok is False
    assert score_value < 4
    assert any("Indonesian/non-target" in reason for reason in reasons)


def test_indonesian_credit_card_vps_n8n_post_is_rejected():
    ok, reasons, score_value, _ = score(
        "Lagi belajar n8n tapi pusing urusan deploy VPS, setting server, atau belum punya kartu kredit? Tenang, ada solusinya!"
    )
    assert ok is False
    assert score_value < 4
    assert any("Indonesian/non-target" in reason for reason in reasons)


def test_indonesian_fomo_pengen_n8n_post_is_rejected():
    ok, reasons, score_value, _ = score(
        "Dulu sempat pengen belajar n8n tapi ragu karena belum tau bakal kepake di mana. Akhirnya mutusin untuk ga belajar dulu karna ga mau belajar cuma karena FOMO."
    )
    assert ok is False
    assert score_value < 4
    assert any("Indonesian/non-target" in reason for reason in reasons)


def test_malaysia_n8n_learning_intent_still_accepted():
    ok, reasons, score_value, _ = score("Saya kat Malaysia, nak belajar n8n untuk automate workflow bisnes.")
    assert ok is True
    assert score_value >= 4
    assert not any("Indonesian/non-target" in reason for reason in reasons)


def test_lightpanda_language_classifier_uses_ai_full_post_decision():
    calls = []
    original = finder.run_hermes_language_classifier

    def fake_classifier(prompt: str, timeout_seconds: int = 90):
        calls.append(prompt)
        assert "Read the WHOLE post text/context" in prompt
        assert "Dulu sempat pengen belajar n8n" in prompt
        return '{"language":"indonesian","containsIndonesian":true,"allowed":false,"confidence":0.96,"reason":"Whole post uses Indonesian slang.","evidence":["pengen","karena","kepake"]}'

    finder.run_hermes_language_classifier = fake_classifier
    try:
        post = {
            "title": "Dulu sempat pengen belajar n8n tapi ragu karena belum tau bakal kepake di mana.",
            "description": "Akhirnya mutusin untuk ga belajar dulu karna ga mau belajar cuma karena FOMO.",
            "text": "Dulu sempat pengen belajar n8n tapi ragu karena belum tau bakal kepake di mana.",
            "url": "https://www.threads.com/@x/post/INDO123",
        }
        decision = finder.classify_language_with_ai(AUTOMATION_ACCOUNT, "belajar n8n", post, {"aiLanguageClassifierEnabled": True})
        ok, reasons, score_value, _ = finder.score_candidate(AUTOMATION_ACCOUNT, "belajar n8n", post, {}, language_decision=decision)
    finally:
        finder.run_hermes_language_classifier = original

    assert calls
    assert decision["language"] == "indonesian"
    assert decision["allowed"] is False
    assert ok is False
    assert score_value < 4
    assert any("AI language rejected" in reason for reason in reasons)


def test_lightpanda_language_classifier_fails_closed_on_ai_error():
    original = finder.run_hermes_language_classifier

    def fake_classifier(prompt: str, timeout_seconds: int = 90):
        raise RuntimeError("model unavailable")

    finder.run_hermes_language_classifier = fake_classifier
    try:
        post = {
            "title": "Saya nak belajar n8n untuk automate WhatsApp follow up bisnes.",
            "description": "Saya nak belajar n8n untuk automate WhatsApp follow up bisnes.",
            "text": "Saya nak belajar n8n untuk automate WhatsApp follow up bisnes.",
        }
        decision = finder.classify_language_with_ai(AUTOMATION_ACCOUNT, "belajar n8n", post, {"aiLanguageClassifierEnabled": True})
        ok, reasons, _, _ = finder.score_candidate(AUTOMATION_ACCOUNT, "belajar n8n", post, {}, language_decision=decision)
    finally:
        finder.run_hermes_language_classifier = original

    assert decision["source"] == "hermes-ai-language-error"
    assert decision["allowed"] is False
    assert ok is False
    assert any("AI language rejected" in reason for reason in reasons)
