import os
import io
import logging
import threading
from typing import Optional
from kokoro_onnx import Kokoro
import soundfile as sf

logger = logging.getLogger(__name__)

class KokoroTTSService:
    _instance: Optional["KokoroTTSService"] = None

    def __init__(self):
        self.kokoro: Optional[Kokoro] = None
        self.is_loaded: bool = False
        self._load_error: Optional[str] = None
        self._lock = threading.Lock()
        self._init_model()

    def _init_model(self):
        try:
            # Base directory for models: backend/models/kokoro/
            base_dir = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "..", "models", "kokoro")
            )
            model_path = os.path.join(base_dir, "kokoro-v1.0.onnx")
            voices_path = os.path.join(base_dir, "voices-v1.0.bin")

            if not os.path.exists(model_path) or not os.path.exists(voices_path):
                self._load_error = f"Kokoro model files not found in {base_dir}"
                logger.warning(self._load_error)
                return

            logger.info(f"Loading Kokoro ONNX model from {model_path}...")
            self.kokoro = Kokoro(model_path, voices_path)
            self.is_loaded = True
            logger.info("Kokoro ONNX model loaded successfully!")
        except Exception as e:
            self._load_error = f"Failed to initialize Kokoro TTS: {str(e)}"
            logger.error(self._load_error)
            self.is_loaded = False

    @classmethod
    def get_instance(cls) -> "KokoroTTSService":
        if cls._instance is None:
            cls._instance = KokoroTTSService()
        return cls._instance

    def generate_speech(self, text: str, voice: str = "af_sarah", speed: float = 1.0) -> bytes:
        if not self.is_loaded or self.kokoro is None:
            raise RuntimeError(self._load_error or "Kokoro TTS service is unavailable")

        clean_input = text.strip()
        if not clean_input:
            raise ValueError("Text input for TTS cannot be empty")

        with self._lock:
            samples, sample_rate = self.kokoro.create(
                clean_input,
                voice=voice,
                speed=speed,
                lang="en-us",
            )

            buffer = io.BytesIO()
            sf.write(buffer, samples, sample_rate, format="WAV")
            buffer.seek(0)
            return buffer.read()

tts_service = KokoroTTSService.get_instance()
