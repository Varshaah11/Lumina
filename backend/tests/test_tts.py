import io
import pathlib
import queue
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from app.ai.speech_text import normalize_for_speech
from app.ai import tts as tts_module
from app.ai.tts import KokoroTTSService, TTSBusyError, TTSUnavailableError
from app.core.config import settings, Settings


class NormalizeForSpeechTests(unittest.TestCase):
    def test_percent(self):
        self.assertEqual(normalize_for_speech("50%"), "50 percent")
        self.assertEqual(normalize_for_speech("Growth was 12.5% last year"), "Growth was 12.5 percent last year")

    def test_currency(self):
        self.assertEqual(normalize_for_speech("$5"), "5 dollars")
        self.assertEqual(normalize_for_speech("It costs $1."), "It costs 1 dollar.")
        self.assertEqual(normalize_for_speech("$1,200.50 total"), "1,200.50 dollars total")
        self.assertEqual(normalize_for_speech("raised $5M"), "raised 5 million dollars")

    def test_ampersand(self):
        self.assertEqual(normalize_for_speech("AT&T"), "A T and T")
        self.assertEqual(normalize_for_speech("R&D budget"), "R and D budget")
        self.assertEqual(normalize_for_speech("salt & pepper"), "salt and pepper")

    def test_slash_dates_and_fractions(self):
        self.assertEqual(normalize_for_speech("10/02"), "10 slash 02")
        self.assertEqual(normalize_for_speech("on 10/02/2024"), "on 10 slash 02 slash 2024")
        self.assertEqual(normalize_for_speech("open 24/7"), "open twenty four seven")
        self.assertEqual(normalize_for_speech("and/or"), "and or")
        self.assertEqual(normalize_for_speech("input/output"), "input output")

    def test_hyphens(self):
        self.assertEqual(normalize_for_speech("pages 3-5"), "pages 3 to 5")
        self.assertEqual(normalize_for_speech("a well-known fact"), "a well known fact")
        self.assertEqual(normalize_for_speech("it is -5 degrees"), "it is minus 5 degrees")
        self.assertEqual(normalize_for_speech("call 555-1234"), "call 555 1234")
        self.assertEqual(normalize_for_speech("on 2024-10-02"), "on 2024 10 02")

    def test_math(self):
        self.assertEqual(normalize_for_speech("2 + 2 = 4"), "2 + 2 equals 4")
        self.assertEqual(normalize_for_speech("3 * 4"), "3 times 4")
        self.assertEqual(normalize_for_speech("2^3"), "2 to the power of 3")
        self.assertEqual(normalize_for_speech("x > 5"), "x greater than 5")

    def test_urls_and_emails(self):
        self.assertEqual(normalize_for_speech("see https://example.com/a/b?x=1 now"), "see example.com now")
        self.assertEqual(normalize_for_speech("mail me@site.org"), "mail me at site.org")

    def test_formatting_still_stripped(self):
        self.assertEqual(normalize_for_speech("**bold** and `code`"), "bold and code")
        self.assertEqual(normalize_for_speech("• item (optional) [x]"), "item optional x")
        self.assertEqual(normalize_for_speech("###"), "")

    def test_empty(self):
        self.assertEqual(normalize_for_speech(""), "")
        self.assertEqual(normalize_for_speech("   "), "")


class FakeWorker:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = 0

    def create(self, chunk, voice, speed, lang):
        self.calls += 1
        if self.fail:
            raise RuntimeError("boom")
        return np.zeros(2400, dtype=np.float32), 24000


def make_service(workers, pool_size=None, loaded=True):
    svc = object.__new__(KokoroTTSService)
    svc.pool_size = len(workers) if pool_size is None else pool_size
    svc._pool = queue.Queue(maxsize=max(svc.pool_size, 1))
    for w in workers:
        svc._pool.put(w)
    svc.is_loaded = loaded
    svc._load_error = None if loaded else "not loaded"
    return svc


class TTSPoolTests(unittest.TestCase):
    def test_is_available_matrix(self):
        self.assertTrue(make_service([FakeWorker()]).is_available)
        self.assertFalse(make_service([FakeWorker()], loaded=False).is_available)
        self.assertFalse(make_service([], pool_size=0).is_available)
        # Empty pool because workers are checked out is still "available" (busy, not broken)
        busy = make_service([FakeWorker()])
        busy._pool.get()
        self.assertTrue(busy.is_available)

    def test_normal_generation_returns_worker_to_pool(self):
        svc = make_service([FakeWorker()])
        wav = svc.generate_speech("Growth was 50% this year.")
        self.assertTrue(wav.startswith(b"RIFF"))
        self.assertEqual(svc._pool.qsize(), 1)

    def test_speech_text_is_normalized_before_synthesis(self):
        seen = []

        class Recording(FakeWorker):
            def create(self, chunk, voice, speed, lang):
                seen.append(chunk)
                return super().create(chunk, voice, speed, lang)

        svc = make_service([Recording()])
        svc.generate_speech("AT&T paid $5 for 50% of it on 10/02")
        self.assertEqual(seen, ["A T and T paid 5 dollars for 50 percent of it on 10 slash 02"])

    def test_failure_still_returns_worker_to_pool(self):
        svc = make_service([FakeWorker(fail=True)])
        with self.assertRaises(RuntimeError):
            svc.generate_speech("Hello there.")
        self.assertEqual(svc._pool.qsize(), 1)

    def test_pool_exhaustion_raises_busy_not_queue_empty(self):
        svc = make_service([FakeWorker()])
        held = svc._pool.get()  # simulate all workers busy
        with patch.object(tts_module, "POOL_ACQUIRE_TIMEOUT", 0.05):
            with self.assertRaises(TTSBusyError):
                svc.generate_speech("Hello there.")
        svc._pool.put(held)
        self.assertEqual(svc._pool.qsize(), 1)  # nothing leaked / duplicated

    def test_unavailable_service_raises_runtimeerror(self):
        svc = make_service([FakeWorker()], loaded=False)
        with self.assertRaises(RuntimeError):
            svc.generate_speech("Hello there.")


class TTSRouteTests(unittest.TestCase):
    def setUp(self):
        from app.main import app
        from app.api.dependencies import get_current_user
        app.dependency_overrides[get_current_user] = lambda: object()
        self.app = app
        self.client = TestClient(app)

    def tearDown(self):
        self.app.dependency_overrides.clear()

    def _post(self, svc):
        with patch("app.api.routes.tts.tts_service", svc):
            return self.client.post("/tts", json={"text": "Hello there."})

    def test_busy_pool_returns_503_with_retry_after(self):
        svc = make_service([FakeWorker()])
        svc._pool.get()
        with patch.object(tts_module, "POOL_ACQUIRE_TIMEOUT", 0.05):
            res = self._post(svc)
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.headers.get("retry-after"), "2")

    def test_success_returns_wav(self):
        res = self._post(make_service([FakeWorker()]))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "audio/wav")
        self.assertTrue(res.content.startswith(b"RIFF"))

    def test_unloaded_returns_503(self):
        res = self._post(make_service([FakeWorker()], loaded=False))
        self.assertEqual(res.status_code, 503)


class RaisingService:
    """Route-level stand-in whose synthesis raises a chosen exception."""
    is_available = True

    def __init__(self, exc):
        self.exc = exc
        self.calls = 0

    def generate_speech(self, text, voice="af_sarah"):
        self.calls += 1
        raise self.exc


class TTSInputLimitTests(unittest.TestCase):
    LIMIT = 50

    def setUp(self):
        from app.main import app
        from app.api.dependencies import get_current_user
        app.dependency_overrides[get_current_user] = lambda: object()
        self.app = app
        self.client = TestClient(app)
        p = patch.object(settings, "KOKORO_MAX_TEXT_LENGTH", self.LIMIT)
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self):
        self.app.dependency_overrides.clear()

    def post(self, svc, payload):
        with patch("app.api.routes.tts.tts_service", svc):
            return self.client.post("/tts", json=payload)

    def test_default_limit_is_2000_and_configurable(self):
        self.assertEqual(Settings.model_fields["KOKORO_MAX_TEXT_LENGTH"].default, 2000)
        with self.assertRaises(Exception):
            Settings(SECRET_KEY="x", DATABASE_URL="sqlite://", KOKORO_MAX_TEXT_LENGTH=0)
        example = (pathlib.Path(__file__).resolve().parents[1] / ".env.example").read_text()
        self.assertIn("KOKORO_MAX_TEXT_LENGTH=2000", example)

    def test_normal_request(self):
        res = self.post(make_service([FakeWorker()]), {"text": "Hello there."})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.content.startswith(b"RIFF"))
        self.assertEqual(sf_info(res.content), 24000)

    def test_missing_text_is_422(self):
        self.assertEqual(self.post(make_service([FakeWorker()]), {}).status_code, 422)

    def test_empty_and_whitespace_text_rejected_without_touching_pool(self):
        for text in ("", "   ", "\n\t "):
            svc = make_service([FakeWorker()])
            res = self.post(svc, {"text": text})
            self.assertEqual(res.status_code, 400, repr(text))
            self.assertEqual(res.json()["detail"], "Text cannot be empty")
            self.assertEqual(svc._pool.qsize(), 1)

    def test_exactly_at_limit_is_accepted(self):
        text = ("word " * 10).strip().ljust(self.LIMIT, "x")
        self.assertEqual(len(text), self.LIMIT)
        res = self.post(make_service([FakeWorker()]), {"text": text})
        self.assertEqual(res.status_code, 200)

    def test_one_over_limit_is_rejected_not_truncated(self):
        text = "a" * (self.LIMIT + 1)
        worker = FakeWorker()
        svc = make_service([worker])
        res = self.post(svc, {"text": text})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], f"Text is too long (maximum {self.LIMIT} characters)")
        self.assertEqual(worker.calls, 0)  # nothing was synthesized, not even a truncated prefix

    def test_oversized_input_never_acquires_a_worker(self):
        svc = make_service([FakeWorker()])
        with patch.object(svc._pool, "get", side_effect=AssertionError("worker acquired for oversized input")) as get, \
             patch.object(svc, "generate_speech", side_effect=AssertionError("inference ran for oversized input")) as gen:
            res = self.post(svc, {"text": "x" * (self.LIMIT * 100)})
        self.assertEqual(res.status_code, 400)
        get.assert_not_called()
        gen.assert_not_called()
        self.assertEqual(svc._pool.qsize(), 1)

    def test_oversized_input_rejected_even_when_service_unavailable_or_busy(self):
        # Input validation comes before availability and pool checks
        svc = make_service([FakeWorker()], loaded=False)
        self.assertEqual(self.post(svc, {"text": "x" * (self.LIMIT + 1)}).status_code, 400)

    def test_limit_counts_raw_characters_before_normalization(self):
        # "$5" expands to "5 dollars" during normalization but the limit applies to what the client sent
        text = "$5" * (self.LIMIT // 2)
        self.assertEqual(len(text), self.LIMIT)
        self.assertEqual(self.post(make_service([FakeWorker()]), {"text": text}).status_code, 200)

    def test_pool_exhaustion_still_503_with_retry_after_2(self):
        svc = make_service([FakeWorker()])
        svc._pool.get()
        with patch.object(tts_module, "POOL_ACQUIRE_TIMEOUT", 0.05):
            res = self.post(svc, {"text": "Hello there."})
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.headers.get("retry-after"), "2")
        self.assertEqual(res.json()["detail"], "TTS is busy, please retry shortly")

    def test_internal_exception_message_is_not_leaked_but_is_logged(self):
        secret = "boom at /Users/someone/private/model.onnx line 42"
        svc = RaisingService(RuntimeError(secret))
        with self.assertLogs("app.api.routes.tts", level="ERROR") as logs:
            res = self.post(svc, {"text": "Hello there."})
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.json(), {"detail": "Speech synthesis failed"})
        self.assertNotIn("model.onnx", res.text)
        self.assertNotIn("RuntimeError", res.text)
        self.assertTrue(any(secret in line for line in logs.output), logs.output)

    def test_value_error_message_is_not_leaked(self):
        svc = RaisingService(ValueError("internal validator detail xyz"))
        with self.assertLogs("app.api.routes.tts", level="WARNING") as logs:
            res = self.post(svc, {"text": "Hello there."})
        self.assertEqual(res.status_code, 400)
        self.assertNotIn("xyz", res.text)
        self.assertTrue(any("internal validator detail xyz" in line for line in logs.output))

    def test_unavailable_error_message_is_not_leaked(self):
        svc = RaisingService(TTSUnavailableError("Kokoro model files not found in /Users/someone/models"))
        with self.assertLogs("app.api.routes.tts", level="ERROR") as logs:
            res = self.post(svc, {"text": "Hello there."})
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json(), {"detail": "TTS is currently unavailable"})
        self.assertNotIn("/Users", res.text)
        self.assertTrue(any("/Users/someone/models" in line for line in logs.output))

    def test_unloaded_service_message_is_generic(self):
        res = self.post(make_service([FakeWorker()], loaded=False), {"text": "Hello there."})
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json(), {"detail": "TTS is currently unavailable"})

    def test_real_synthesis_failure_message_not_leaked(self):
        class Leaky(FakeWorker):
            def create(self, *a, **k):
                raise RuntimeError("onnx secret detail")
        svc = make_service([Leaky()])
        res = self.post(svc, {"text": "Hello there."})
        self.assertEqual(res.status_code, 500)
        self.assertNotIn("secret", res.text)
        self.assertEqual(svc._pool.qsize(), 1)  # worker still returned after failure


def sf_info(wav_bytes):
    import soundfile as sf
    return sf.info(io.BytesIO(wav_bytes)).samplerate


if __name__ == "__main__":
    unittest.main()
