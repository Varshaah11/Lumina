import os
import sys
import time
import re
import threading
import queue
from typing import List, Dict, Any

# Ensure app imports work from backend directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.ai.tts import tts_service

def normalize_text_for_tts(raw_text: str) -> str:
    if not raw_text:
        return ""
    text = raw_text
    text = re.sub(r'```[\s\S]*?```', ' ', text)
    unclosed = text.rfind("```")
    if unclosed != -1:
        text = text[:unclosed]
    text = re.sub(r'^[ \t]*[-*=_]{2,}[ \t]*$', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'^[ \t]*\|.*\|[ \t]*$', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'^[ \t]*#{1,6}\s+', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'^[ \t]*>\s+', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'^[ \t]*[•–—▪▫◆◇➢▶\-\*\+]\s+', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'^[ \t]*\d+\.\s+', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'[•–—▪▫◆◇➢▶]', ' ', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    text = re.sub(r'!\[([^\]]*)\]\([^)]*\)', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'(\*\*|__|\*|_|~~)(.*?)\1', r'\2', text)
    text = re.sub(r'[-*=_]{2,}', ' ', text)
    text = re.sub(r'#{2,}', ' ', text)
    text = re.sub(r'<[^>]*>', ' ', text)
    text = re.sub(r'https?:\/\/\S+', '', text)
    text = re.sub(r'\n{2,}', '. ', text)
    text = re.sub(r'[\r\n]+', ' ', text)
    text = re.sub(r'\s{2,}', ' ', text)
    return text.strip()

def is_meaningful_speech_chunk(chunk: str) -> bool:
    if not chunk or len(chunk.strip()) < 3:
        return False
    if not re.search(r'[a-zA-Z]{2,}', chunk):
        return False
    stripped = re.sub(r'[^a-zA-Z0-9]', '', chunk)
    return len(stripped) >= 2

def extract_streaming_tts_chunks(normalized_text: str, processed_len: int, is_complete: bool):
    chunks = []
    remaining = normalized_text[processed_len:]
    advanced_len = 0

    while len(remaining) > 0:
        if len(remaining) < 35 and not is_complete:
            break

        punct_matches = list(re.finditer(r'([.?!;]+|:\s+|,|\n+)', remaining))
        found_split_idx = -1
        for m in punct_matches:
            idx_after = m.end()
            if 35 <= idx_after <= 90:
                found_split_idx = idx_after
                break
            if idx_after > 90:
                break

        if found_split_idx != -1:
            cand = remaining[:found_split_idx].strip()
            advanced_len += found_split_idx
            remaining = remaining[found_split_idx:]
            if is_meaningful_speech_chunk(cand):
                chunks.append({"text": cand, "raw_length": advanced_len})
                advanced_len = 0
            continue

        if len(remaining) >= 65:
            search_lim = min(80, len(remaining))
            last_space = remaining.rfind(" ", 0, search_lim)
            if last_space >= 35:
                cand = remaining[:last_space].strip()
                advanced_len += last_space + 1
                remaining = remaining[last_space + 1:]
                if is_meaningful_speech_chunk(cand):
                    chunks.append({"text": cand, "raw_length": advanced_len})
                    advanced_len = 0
                continue

        if is_complete:
            cand = remaining.strip()
            advanced_len += len(remaining)
            remaining = ""
            if is_meaningful_speech_chunk(cand):
                chunks.append({"text": cand, "raw_length": advanced_len})
            break

        break

    return chunks

class SimulatedStreamingPipeline:
    def __init__(self, max_concurrency: int = 2):
        self.max_concurrency = max_concurrency
        self.tts_queue = []
        self.in_flight_count = 0
        self.audio_ready_map = {}
        self.lock = threading.Lock()
        self.turn_id = 1
        self.current_play_seq = 0
        self.playback_events = []
        self.is_playing = False
        self.turn_start_time = 0

    def run_turn(self, tokens_stream: List[str], turn_name: str) -> Dict[str, Any]:
        self.turn_id += 1
        turn_id = self.turn_id
        self.turn_start_time = time.perf_counter()
        self.tts_queue = []
        self.in_flight_count = 0
        self.audio_ready_map = {}
        self.current_play_seq = 0
        self.playback_events = []
        self.is_playing = False

        print(f"\n==========================================================")
        print(f"  RUNNING TEST: {turn_name}")
        print(f"==========================================================")

        accumulated_text = ""
        processed_len = 0
        seq_counter = 0

        first_token_time = None
        first_tts_dispatch_time = None
        first_audio_ready_time = None
        first_audio_play_time = None

        # Simulate progressive LLM streaming
        for idx, token in enumerate(tokens_stream):
            if first_token_time is None:
                first_token_time = time.perf_counter()
            accumulated_text += token
            time.sleep(0.015)  # simulate LLM token interval ~15ms
            is_complete = (idx == len(tokens_stream) - 1)

            norm_text = normalize_text_for_tts(accumulated_text)
            chunks = extract_streaming_tts_chunks(norm_text, processed_len, is_complete)

            for ch in chunks:
                processed_len += ch["raw_length"]
                seq = seq_counter
                seq_counter += 1
                with self.lock:
                    self.tts_queue.append({"seq": seq, "text": ch["text"]})
                if first_tts_dispatch_time is None:
                    first_tts_dispatch_time = time.perf_counter()
                self._dispatch_tts_workers(turn_id)

        # Wait for all synthesis and playback to complete
        while True:
            with self.lock:
                done = (
                    len(self.tts_queue) == 0 and
                    self.in_flight_count == 0 and
                    self.current_play_seq >= seq_counter and
                    not self.is_playing
                )
            if done:
                break
            time.sleep(0.05)

        total_turn_time = time.perf_counter() - self.turn_start_time

        # Print structured metrics
        print("\n--- PERFORMANCE & PIPELINE TIMELINE ---")
        llm_first_token_ms = (first_token_time - self.turn_start_time) * 1000 if first_token_time else 0
        first_tts_req_ms = (first_tts_dispatch_time - self.turn_start_time) * 1000 if first_tts_dispatch_time else 0
        first_audio_ready_ms = (self.playback_events[0]["ready_time"] - self.turn_start_time) * 1000 if self.playback_events else 0
        first_audio_play_ms = (self.playback_events[0]["play_start"] - self.turn_start_time) * 1000 if self.playback_events else 0

        print(f"  * LLM First Token:           {llm_first_token_ms:.1f}ms")
        print(f"  * First TTS Request Start:   {first_tts_req_ms:.1f}ms")
        print(f"  * First Audio Ready:         {first_audio_ready_ms:.1f}ms")
        print(f"  * First Audio Playback Start:{first_audio_play_ms:.1f}ms")
        print(f"  * Total Chunks Processed:    {seq_counter}")
        print(f"  * Total Turn Duration:       {total_turn_time:.2f}s\n")

        print("--- AUDIO CHUNK PLAYBACK SEQUENCE & GAPS ---")
        gaps = []
        for i, ev in enumerate(self.playback_events):
            gap_str = f"{ev['gap_ms']:.1f}ms" if ev['gap_ms'] is not None else "0.0ms (first)"
            if ev['gap_ms'] is not None:
                gaps.append(ev['gap_ms'])
            print(
                f"  Chunk #{ev['seq']}: \"{ev['text'][:40]}...\" ({ev['chars']} chars) | "
                f"Synth: {ev['synth_sec']:.2f}s | Audio: {ev['audio_sec']:.2f}s | "
                f"Play Start: {ev['play_start'] - self.turn_start_time:.2f}s | "
                f"Play End: {ev['play_end'] - self.turn_start_time:.2f}s | Gap: {gap_str}"
            )

        max_gap = max(gaps) if gaps else 0.0
        avg_gap = sum(gaps) / len(gaps) if gaps else 0.0
        print(f"\n  * Inter-Chunk Max Audio Gap: {max_gap:.1f}ms")
        print(f"  * Inter-Chunk Avg Audio Gap: {avg_gap:.1f}ms")

        return {
            "first_audio_play_ms": first_audio_play_ms,
            "max_gap_ms": max_gap,
            "avg_gap_ms": avg_gap,
            "chunks_count": seq_counter,
            "events": self.playback_events
        }

    def _dispatch_tts_workers(self, turn_id: int):
        with self.lock:
            while self.in_flight_count < self.max_concurrency and len(self.tts_queue) > 0:
                item = self.tts_queue.pop(0)
                self.in_flight_count += 1
                threading.Thread(
                    target=self._tts_worker,
                    args=(turn_id, item["seq"], item["text"]),
                    daemon=True
                ).start()

    def _tts_worker(self, turn_id: int, seq: int, text: str):
        t0 = time.perf_counter()
        try:
            wav_bytes = tts_service.generate_speech(text, voice="af_sarah")
            synth_dur = time.perf_counter() - t0
            t_ready = time.perf_counter()

            if turn_id != self.turn_id:
                return

            import soundfile as sf
            import io
            with sf.SoundFile(io.BytesIO(wav_bytes)) as f:
                audio_dur = len(f) / f.samplerate

            with self.lock:
                self.in_flight_count = max(0, self.in_flight_count - 1)
                self.audio_ready_map[seq] = {
                    "seq": seq,
                    "text": text,
                    "chars": len(text),
                    "synth_sec": synth_dur,
                    "audio_sec": audio_dur,
                    "ready_time": t_ready
                }

            self._play_next_in_queue(turn_id)
            self._dispatch_tts_workers(turn_id)
        except Exception as e:
            with self.lock:
                self.in_flight_count = max(0, self.in_flight_count - 1)
                if self.current_play_seq == seq:
                    self.current_play_seq += 1
            print(f"[ERROR] TTS worker failed for seq #{seq}: {e}")
            self._play_next_in_queue(turn_id)
            self._dispatch_tts_workers(turn_id)

    def _play_next_in_queue(self, turn_id: int):
        with self.lock:
            if turn_id != self.turn_id or self.is_playing:
                return
            target_seq = self.current_play_seq
            if target_seq in self.audio_ready_map:
                chunk = self.audio_ready_map.pop(target_seq)
                self.is_playing = True
            else:
                return

        threading.Thread(
            target=self._audio_player,
            args=(turn_id, chunk),
            daemon=True
        ).start()

    def _audio_player(self, turn_id: int, chunk: Dict[str, Any]):
        play_start = time.perf_counter()
        last_end = self.playback_events[-1]["play_end"] if self.playback_events else None
        gap_ms = (play_start - last_end) * 1000 if last_end is not None else None

        # Simulate real-time audio playback
        time.sleep(chunk["audio_sec"])
        play_end = time.perf_counter()

        with self.lock:
            if turn_id != self.turn_id:
                return
            self.playback_events.append({
                "seq": chunk["seq"],
                "text": chunk["text"],
                "chars": chunk["chars"],
                "synth_sec": chunk["synth_sec"],
                "audio_sec": chunk["audio_sec"],
                "ready_time": chunk["ready_time"],
                "play_start": play_start,
                "play_end": play_end,
                "gap_ms": gap_ms
            })
            self.is_playing = False
            self.current_play_seq += 1

        self._play_next_in_queue(turn_id)

def run_all_acceptance_tests():
    pipeline = SimulatedStreamingPipeline(max_concurrency=2)

    # TEST 1: Simple 2-sentence response
    t1_text = (
        "Recursion is a programming technique where a function calls itself to solve smaller problems. "
        "It continues until reaching a base condition that stops further execution and returns the result."
    )
    t1_tokens = [t1_text[i:i+4] for i in range(0, len(t1_text), 4)]
    res1 = pipeline.run_turn(t1_tokens, "TEST 1: 2-Sentence Concise Response ('What is recursion?')")

    # TEST 2: Markdown-heavy response with code, tables, headings, and horizontal rules
    t2_text = (
        "### Recursion Breakdown\n"
        "Here is a simple example in Python:\n"
        "```python\n"
        "def factorial(n):\n"
        "    if n <= 1: return 1\n"
        "    return n * factorial(n - 1)\n"
        "```\n"
        "-------------------\n"
        "• First, verify the base case condition.\n"
        "• Next, execute the recursive step.\n"
        "This allows complex computational structures to remain compact."
    )
    t2_tokens = [t2_text[i:i+4] for i in range(0, len(t2_text), 4)]
    res2 = pipeline.run_turn(t2_tokens, "TEST 2: Markdown-Heavy Response (Code blocks, -----, bullets, headers)")

    # TEST 3: Long streaming response (800+ chars)
    t3_text = (
        "Deep learning is a subset of machine learning based on artificial neural networks with representation learning. "
        "The adjective deep in deep learning refers to the use of multiple layers in the network. "
        "Methods used can be either supervised, semi-supervised or unsupervised. "
        "Deep learning architectures such as deep neural networks and recurrent neural networks have been applied to fields including computer vision, speech recognition, and natural language processing. "
        "These models have produced results comparable to, and in some cases surpassing, human expert performance."
    )
    t3_tokens = [t3_text[i:i+4] for i in range(0, len(t3_text), 4)]
    res3 = pipeline.run_turn(t3_tokens, "TEST 3: Multi-Chunk Continuous Long Response")

    print("\n==========================================================")
    print("                 FINAL SUMMARY REPORT                     ")
    print("==========================================================")
    print(f"Test 1 (2-sentence response): First audio play = {res1['first_audio_play_ms']:.1f}ms | Max Gap = {res1['max_gap_ms']:.1f}ms")
    print(f"Test 2 (Markdown-heavy):       First audio play = {res2['first_audio_play_ms']:.1f}ms | Max Gap = {res2['max_gap_ms']:.1f}ms")
    print(f"Test 3 (Long response):        First audio play = {res3['first_audio_play_ms']:.1f}ms | Max Gap = {res3['max_gap_ms']:.1f}ms")
    print("All tests completed successfully.")

if __name__ == "__main__":
    run_all_acceptance_tests()
