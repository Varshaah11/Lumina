import os
import io
import re
import time
import queue
import logging
from typing import Optional, List
import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro
import soundfile as sf

logger = logging.getLogger(__name__)

class KokoroTTSService:
    _instance: Optional["KokoroTTSService"] = None

    def __init__(self, pool_size: int = 2):
        self.pool_size: int = int(os.environ.get("KOKORO_CONCURRENCY", str(pool_size)))
        self._pool: queue.Queue = queue.Queue(maxsize=self.pool_size)
        self.is_loaded: bool = False
        self._load_error: Optional[str] = None
        self._init_model_pool()

    def _init_model_pool(self):
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

            providers = ["CPUExecutionProvider"]
            threads = 4
            exec_mode = ort.ExecutionMode.ORT_SEQUENTIAL

            logger.info(
                f"[TTS ENGINE] Initializing Kokoro Session Pool (size={self.pool_size}): "
                f"provider={providers}, threads={threads}, mode=ORT_SEQUENTIAL"
            )

            # Initialize pre-allocated Kokoro worker sessions in pool
            for i in range(self.pool_size):
                session_options = ort.SessionOptions()
                session_options.intra_op_num_threads = threads
                session_options.inter_op_num_threads = 1
                session_options.execution_mode = exec_mode
                session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

                sess = ort.InferenceSession(
                    model_path,
                    session_options,
                    providers=providers
                )
                kokoro_instance = Kokoro.from_session(sess, voices_path)
                self._pool.put(kokoro_instance)
                logger.info(f"[TTS ENGINE] Worker session {i+1}/{self.pool_size} initialized successfully")

            self.is_loaded = True
            logger.info(
                f"[TTS ENGINE] model_initialized=True | pool_size={self.pool_size} | "
                f"threads_per_worker={threads} | provider={providers[0]} | device=CPU"
            )
        except Exception as e:
            self._load_error = f"Failed to initialize Kokoro TTS session pool: {str(e)}"
            logger.error(self._load_error)
            self.is_loaded = False

    @classmethod
    def get_instance(cls) -> "KokoroTTSService":
        if cls._instance is None:
            cls._instance = KokoroTTSService()
        return cls._instance

    def _split_into_chunks(self, text: str, max_chars: int = 350) -> List[str]:
        """
        Sentence-aware text grouping for Kokoro ONNX inference.
        Groups sentences into clean chunks under max_chars=350 to ensure phoneme count stays strictly under 510 phonemes.
        """
        clean = re.sub(r'\s+', ' ', text).strip()
        if not clean:
            return []

        raw_sentences = re.split(r'(?<=[.!?])\s+', clean)
        chunks: List[str] = []
        current_chunk = ""

        for sentence in raw_sentences:
            sentence = sentence.strip()
            if not sentence:
                continue

            if not current_chunk:
                current_chunk = sentence
            elif len(current_chunk) + 1 + len(sentence) <= max_chars:
                current_chunk += " " + sentence
            else:
                chunks.append(current_chunk)
                current_chunk = sentence

        if current_chunk:
            chunks.append(current_chunk)

        return chunks

    def generate_speech(self, text: str, voice: str = "af_sarah", speed: float = 1.0) -> bytes:
        if not self.is_loaded or self._pool.empty() and self.pool_size == 0:
            raise RuntimeError(self._load_error or "Kokoro TTS service is unavailable")

        start_total = time.perf_counter()

        # Clean formatting tokens, unicode bullets, and verify spoken words exist
        clean_input = re.sub(r'[-=_*#`~<>|•–—▪▫◆◇➢▶\(\)\[\]\{\}\/\\^@&$%]+', ' ', text).strip()
        clean_input = re.sub(r'\s+', ' ', clean_input)
        if not clean_input or not re.search(r'[a-zA-Z0-9]', clean_input):
            raise ValueError("Text input contains no spoken words")

        # Step 1: Sentence-Aware Preprocessing
        start_prep = time.perf_counter()
        chunks = self._split_into_chunks(clean_input, max_chars=350)
        end_prep = time.perf_counter()
        prep_time = end_prep - start_prep

        logger.info(
            f"[TTS] Request received: {len(clean_input)} chars | "
            f"Sentence-grouped into {len(chunks)} chunk(s) (max_chars=350) in {prep_time:.4f}s"
        )

        all_audio_samples: List[np.ndarray] = []
        sample_rate = 24000

        # Acquire an initialized Kokoro worker session from bounded pool
        kokoro_worker = self._pool.get(timeout=60.0)
        start_inference = time.perf_counter()
        try:
            for idx, chunk in enumerate(chunks):
                t0 = time.perf_counter()
                try:
                    # Kokoro.create internally handles phonemization and tokenization
                    samples, sr = kokoro_worker.create(
                        chunk,
                        voice=voice,
                        speed=speed,
                        lang="en-us",
                    )
                    t1 = time.perf_counter()
                    inference_time = t1 - t0

                    if sr:
                        sample_rate = sr
                    all_audio_samples.append(samples)

                    audio_duration = len(samples) / sample_rate if sample_rate > 0 else 0
                    rtf = inference_time / audio_duration if audio_duration > 0 else 0

                    logger.info(
                        f"[TTS Chunk {idx+1}/{len(chunks)}] chars={len(chunk)}, words={len(chunk.split())} | "
                        f"ONNX inference={inference_time:.4f}s | audio_duration={audio_duration:.2f}s | RTF={rtf:.2f}x"
                    )
                except Exception as chunk_err:
                    logger.warning(f"[TTS] Chunk {idx+1} synthesis warning: {chunk_err}")
        finally:
            # Return worker session to pool
            self._pool.put(kokoro_worker)

        end_inference = time.perf_counter()
        total_inference_time = end_inference - start_inference

        if not all_audio_samples:
            raise RuntimeError("Failed to generate audio for any text chunk")

        # Step 3: Audio Concatenation & WAV Encoding
        start_wav = time.perf_counter()
        combined_samples = np.concatenate(all_audio_samples) if len(all_audio_samples) > 1 else all_audio_samples[0]

        buffer = io.BytesIO()
        sf.write(buffer, combined_samples, sample_rate, format="WAV")
        buffer.seek(0)
        wav_bytes = buffer.read()
        end_wav = time.perf_counter()
        wav_time = end_wav - start_wav

        end_total = time.perf_counter()
        total_time = end_total - start_total

        logger.info(
            f"[TTS Complete] Total: {total_time:.4f}s | Prep: {prep_time:.4f}s | "
            f"Inference ({len(chunks)} chunk(s)): {total_inference_time:.4f}s | "
            f"WAV Encode: {wav_time:.4f}s | Audio size: {len(wav_bytes)} bytes"
        )

        return wav_bytes

tts_service = KokoroTTSService.get_instance()
