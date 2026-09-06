import os
import sys
import time
import io
import re
import queue
import soundfile as sf
import numpy as np

# Ensure app imports work from backend directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.ai.tts import tts_service

def run_benchmark():
    print("==========================================================")
    print("             LUMINA KOKORO TTS BENCHMARK                 ")
    print("==========================================================")

    test_inputs = {
        "A": "Hello Varsha.",
        "B": "Hello Varsha. How are you today?",
        "C": "Recursion is a fundamental computer science concept where a function calls itself to solve smaller subproblems.",
        "D": "Recursion is a fundamental computer science concept where a function calls itself to solve smaller subproblems. Understanding how recursion works requires breaking it down into two crucial components: the base case and the recursive step."
    }

    if not tts_service.is_loaded:
        print("ERROR: Kokoro TTS service failed to load.")
        sys.exit(1)

    try:
        kokoro = tts_service._pool.get(timeout=10.0)
    except queue.Empty:
        print("ERROR: Timeout acquiring Kokoro worker from pool.")
        sys.exit(1)

    try:
        for key, text in test_inputs.items():
            print(f"\n--- TEST {key}: {len(text)} characters ({len(text.split())} words) ---")
            print(f"Text: \"{text}\"")

            t0 = time.perf_counter()

            # Stage 1: Phonemization
            t_ph0 = time.perf_counter()
            phonemes = kokoro.tokenizer.phonemize(text, lang="en-us")
            t_ph1 = time.perf_counter()
            phonemize_time = t_ph1 - t_ph0

            # Stage 2: Tokenization
            t_tok0 = time.perf_counter()
            tokens = kokoro.tokenizer.tokenize(phonemes)
            t_tok1 = time.perf_counter()
            tokenize_time = t_tok1 - t_tok0

            # Stage 3: ONNX Inference
            t_inf0 = time.perf_counter()
            samples, sr = kokoro.create(text, voice="af_sarah", speed=1.0, lang="en-us")
            t_inf1 = time.perf_counter()
            inference_time = t_inf1 - t_inf0 - phonemize_time - tokenize_time
            total_create = t_inf1 - t_inf0

            # Stage 4: WAV Encoding
            t_wav0 = time.perf_counter()
            buf = io.BytesIO()
            sf.write(buf, samples, sr, format="WAV")
            buf.seek(0)
            wav_bytes = buf.read()
            t_wav1 = time.perf_counter()
            wav_encode_time = t_wav1 - t_wav0

            total_time = time.perf_counter() - t0

            print(f"  * Characters:         {len(text)}")
            print(f"  * Words:              {len(text.split())}")
            print(f"  * Phonemes:           {len(phonemes)}")
            print(f"  * Phonemization Time: {phonemize_time:.4f}s")
            print(f"  * Tokenization Time:  {tokenize_time:.4f}s")
            print(f"  * ONNX Inference:     {inference_time:.4f}s")
            print(f"  * WAV Encoding Time:  {wav_encode_time:.4f}s")
            print(f"  * Total Time:         {total_time:.4f}s")
            print(f"  * Generated WAV Size: {len(wav_bytes)} bytes ({len(samples)/sr:.2f}s of audio)")
    finally:
        tts_service._pool.put(kokoro)

if __name__ == "__main__":
    run_benchmark()
