import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "lightpanda_threads_finder.py"
spec = importlib.util.spec_from_file_location("lightpanda_threads_finder", SCRIPT)
finder = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(finder)

PROPERTY_ACCOUNT = {
    "id": "threads-1",
    "label": "@koiisss_",
    "intentMode": "property",
    "buyerIntentOnly": True,
    "buyerIntentMinConfidence": 0.68,
    "requiredLanguage": "either",
    "keywords": ["cari rumah", "nak beli rumah", "rumah sewa"],
}

LANGUAGE_ALLOWED = {
    "language": "mixed",
    "containsIndonesian": False,
    "allowed": True,
    "confidence": 0.96,
    "source": "hermes-ai-language",
    "reason": "BM/Manglish + English.",
}


def test_matcha_post_is_rejected_by_ai_buyer_intent_after_full_post_read():
    calls = []
    original = finder.run_hermes_buyer_intent_classifier

    def fake_classifier(prompt: str, timeout_seconds: int = 90):
        calls.append(prompt)
        assert "Read the WHOLE post text/context" in prompt
        assert "cari rumah dia" in prompt
        assert "matcha latte jumbo size" in prompt
        return '{"intent":"irrelevant","accepted":false,"confidence":0.98,"reason":"The author bought matcha latte after finding someone\'s house/location; they are not looking to buy or rent a house.","evidence":["I bought matcha latte","cari rumah dia"]}'

    finder.run_hermes_buyer_intent_classifier = fake_classifier
    try:
        post = {
            "url": "https://www.threads.com/@aleennnnn/post/DZfWzyGkw9e",
            "title": "Yeayyyyy walau sesat cari rumah dia, i got it finally. Worth every penny! I bought matcha latte jumbo size and also requested extra kaww lurve terok ishh🤏🏼",
            "description": "Yeayyyyy walau sesat cari rumah dia, i got it finally. Worth every penny! I bought matcha latte jumbo size and also requested extra kaww lurve terok ishh🤏🏼",
            "text": "Yeayyyyy walau sesat cari rumah dia, i got it finally. Worth every penny! I bought matcha latte jumbo size and also requested extra kaww lurve terok ishh🤏🏼",
        }
        ok, reasons, score_value, buyer_intent = finder.score_candidate(
            PROPERTY_ACCOUNT,
            "cari rumah",
            post,
            {"aiBuyerIntentClassifierEnabled": True, "aiBuyerIntentTimeoutSeconds": 90},
            language_decision=LANGUAGE_ALLOWED,
        )
    finally:
        finder.run_hermes_buyer_intent_classifier = original

    assert calls
    assert ok is False
    assert buyer_intent["intent"] == "irrelevant"
    assert buyer_intent["source"] == "hermes-ai-buyer-intent"
    assert buyer_intent["accepted"] is False
    assert score_value < 8
    assert any("buyer intent rejected: irrelevant" in reason for reason in reasons)
