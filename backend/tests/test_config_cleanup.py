import importlib.metadata
import io
import pathlib
import queue
import re
import unittest
from unittest.mock import MagicMock, patch

import numpy as np

from app.ai import tts as tts_module
from app.ai.router import intelligence_router
from app.ai.tts import KokoroTTSService
from app.core.config import Settings, settings

BACKEND = pathlib.Path(__file__).resolve().parents[1]


class FakeWorker:
    def __init__(self):
        self.voices = []

    def create(self, chunk, voice, speed, lang):
        self.voices.append(voice)
        return np.zeros(2400, dtype=np.float32), 24000


def make_service(worker):
    svc = object.__new__(KokoroTTSService)
    svc.pool_size = 1
    svc._pool = queue.Queue(maxsize=1)
    svc._pool.put(worker)
    svc.is_loaded = True
    svc._load_error = None
    return svc


class ModelSettingsTests(unittest.TestCase):
    def test_defaults_match_previous_hardcoded_values(self):
        self.assertEqual(Settings.model_fields["OLLAMA_PRIMARY_MODEL"].default, "llama3.1:8b")
        self.assertEqual(Settings.model_fields["OLLAMA_FALLBACK_MODEL"].default, "llama3.2:3b")
        self.assertEqual(Settings.model_fields["KOKORO_VOICE"].default, "af_sarah")
        self.assertEqual(Settings.model_fields["KOKORO_THREADS"].default, 4)

    def test_values_come_from_environment(self):
        with patch.dict("os.environ", {"OLLAMA_PRIMARY_MODEL": "big:1", "OLLAMA_FALLBACK_MODEL": "small:1",
                                       "KOKORO_VOICE": "af_bella", "KOKORO_THREADS": "2"}):
            s = Settings(SECRET_KEY="x", DATABASE_URL="sqlite://")
        self.assertEqual((s.OLLAMA_PRIMARY_MODEL, s.OLLAMA_FALLBACK_MODEL, s.KOKORO_VOICE, s.KOKORO_THREADS),
                         ("big:1", "small:1", "af_bella", 2))

    def test_threads_must_be_positive(self):
        with self.assertRaises(Exception):
            Settings(SECRET_KEY="x", DATABASE_URL="sqlite://", KOKORO_THREADS=0)

    def test_service_constants_follow_settings(self):
        from app.ai import service
        self.assertEqual(service.PRIMARY_MODEL, settings.OLLAMA_PRIMARY_MODEL)
        self.assertEqual(service.FALLBACK_MODEL, settings.OLLAMA_FALLBACK_MODEL)

    def test_router_defaults_come_from_settings(self):
        with patch.object(settings, "OLLAMA_PRIMARY_MODEL", "big:1"), patch.object(settings, "OLLAMA_FALLBACK_MODEL", "small:1"):
            strong = intelligence_router.route_request("write a python function", available_models=["big:1", "small:1"])
            weak = intelligence_router.route_request("write a python function", available_models=["small:1"])
            fast = intelligence_router.route_request("hello there", available_models=["big:1", "small:1"])
        self.assertEqual(strong["model"], "big:1")
        self.assertEqual(weak["model"], "small:1")
        self.assertEqual(fast["model"], "small:1")

    def test_router_explicit_models_still_win(self):
        route = intelligence_router.route_request("write a python function", available_models=["x"], primary_model="x", fallback_model="y")
        self.assertEqual(route["model"], "x")

    def test_redundant_except_is_gone(self):
        src = (BACKEND / "app/ai/service.py").read_text()
        self.assertNotIn("ConnectError", src)
        self.assertNotIn("except (ConnectError, Exception)", src)


class TTSSettingsTests(unittest.TestCase):
    def test_default_voice_comes_from_settings(self):
        worker = FakeWorker()
        make_service(worker).generate_speech("Hello there.")
        self.assertEqual(worker.voices, [settings.KOKORO_VOICE])

    def test_configured_voice_is_used_and_explicit_voice_wins(self):
        worker = FakeWorker()
        svc = make_service(worker)
        with patch.object(settings, "KOKORO_VOICE", "af_bella"):
            svc.generate_speech("Hello there.")
        svc.generate_speech("Hello there.", voice="am_adam")
        self.assertEqual(worker.voices, ["af_bella", "am_adam"])

    def test_route_passes_configured_voice(self):
        route_src = (BACKEND / "app/api/routes/tts.py").read_text()
        self.assertIn("voice=settings.KOKORO_VOICE", route_src)
        self.assertNotIn('"af_sarah"', route_src.replace("voice from KOKORO_VOICE", ""))

    def test_thread_count_comes_from_settings(self):
        captured = []

        class Options:
            pass

        def fake_session(model_path, options, providers):
            captured.append(options.intra_op_num_threads)
            return MagicMock()

        with patch.object(settings, "KOKORO_THREADS", 3), \
             patch.object(tts_module.os.path, "exists", return_value=True), \
             patch.object(tts_module.ort, "InferenceSession", fake_session), \
             patch.object(tts_module.Kokoro, "from_session", return_value=MagicMock()):
            svc = KokoroTTSService(pool_size=2)
            self.assertEqual(captured, [], "constructing the service must not load the model")
            svc.ensure_loaded()
        self.assertTrue(svc.is_loaded)
        self.assertEqual(captured, [3, 3])


class RequirementsTests(unittest.TestCase):
    def pins(self):
        pins = {}
        for line in (BACKEND / "requirements.txt").read_text().splitlines():
            m = re.match(r"^([A-Za-z0-9_.\-]+)==(\S+)$", line.strip())
            if m:
                pins[m.group(1).lower().replace("_", "-")] = m.group(2)
        return pins

    def test_directly_imported_numpy_and_onnxruntime_are_pinned_to_the_working_versions(self):
        pins = self.pins()
        for name in ("numpy", "onnxruntime"):
            self.assertIn(name, pins)
            self.assertEqual(pins[name], importlib.metadata.version(name), name)

    def test_every_third_party_import_in_app_is_declared(self):
        import ast
        import sys
        declared = {"fastapi", "starlette", "pydantic", "pydantic-settings", "sqlalchemy", "bcrypt", "pyjwt", "ollama", "numpy",
                    "onnxruntime", "kokoro-onnx", "soundfile", "pypdf", "python-docx"}
        pins = set(self.pins())
        std = set(sys.stdlib_module_names)
        import_to_dist = {"jwt": "pyjwt", "docx": "python-docx", "kokoro_onnx": "kokoro-onnx", "pydantic_settings": "pydantic-settings"}
        for path in (BACKEND / "app").rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                mods = []
                if isinstance(node, ast.Import):
                    mods = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    mods = [node.module.split(".")[0]]
                for m in mods:
                    if m in std or m == "app":
                        continue
                    dist = import_to_dist.get(m, m.lower())
                    self.assertIn(dist, pins, f"{path.name} imports {m} but requirements.txt has no pin for {dist}")
                    self.assertIn(dist, declared)

    def test_env_example_documents_new_settings(self):
        text = (BACKEND / ".env.example").read_text()
        for key in ("OLLAMA_PRIMARY_MODEL=llama3.1:8b", "OLLAMA_FALLBACK_MODEL=llama3.2:3b", "KOKORO_VOICE=af_sarah", "KOKORO_THREADS=4"):
            self.assertIn(key, text)


if __name__ == "__main__":
    unittest.main()
