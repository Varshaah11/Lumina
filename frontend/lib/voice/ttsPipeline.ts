/**
 * Streaming text-to-speech pipeline: chunk queue -> bounded /tts prefetch -> strictly ordered playback.
 *
 * This is a plain class (not React state). All queue state lives in fields of one long-lived instance, so
 * every function always reads and writes the CURRENT queue: there are no closures over render-time values that can go
 * stale. The only things it needs from the surrounding voice session are reached through `TtsPipelineHost`.
 *
 * A "turn" is one user utterance + the spoken reply. Every async step carries the turn id it started under and quietly
 * drops its result if the turn was invalidated (stop, interruption, new utterance, exit) while it was in flight.
 */
import { debugLog } from "@/lib/debug";
import { isAbortError } from "@/lib/errors";
import { sanitizeTextForTTS } from "@/lib/speechSanitizer";
import { extractStreamingTTSChunks, isMeaningfulSpeechChunk } from "./chunker";
import { API_BASE_URL } from "@/lib/config";

/** Max /tts requests being synthesized at the same time (the next chunks are prefetched while one plays). */
export const MAX_IN_FLIGHT_TTS = 2;

interface TTSQueueItem {
  seq: number;
  text: string;
}

interface AudioChunk {
  seq: number;
  objectUrl: string;
  text: string;
  chars: number;
  ttsStartMs: number;
  ttsEndMs: number;
  ttsDurationMs: number;
  audioQueuedMs: number;
}

/** What the pipeline needs from the voice session that owns it. */
export interface TtsPipelineHost {
  /** True while voice mode is open; nothing is fetched or played otherwise. */
  isVoiceActive(): boolean;
  /** A chunk just started playing: show SPEAKING and make sure the recognizer listens for interruptions. */
  onChunkPlaybackStart(): void;
  /** Every chunk of the reply was synthesized and played. */
  onAllChunksPlayed(): void;
}

const NOOP_TTS_HOST: TtsPipelineHost = {
  isVoiceActive: () => false,
  onChunkPlaybackStart: () => {},
  onAllChunksPlayed: () => {},
};

export class TtsPipeline {
  /** Identity of the current turn; bumped to invalidate everything still in flight. */
  activeTurnId = 0;
  isPlaying = false;
  currentChunkText = "";

  private processedSpeechLength = 0;
  private ttsSequenceCounter = 0;
  private ttsQueue: TTSQueueItem[] = [];
  private inFlightCount = 0;
  private audioReady = new Map<number, AudioChunk>();
  private currentPlaySequence = 0;
  private previousChunkAudioEndTime: number | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private currentAudioUrl: string | null = null;
  private isStreamComplete = false;
  private abortControllers: AbortController[] = [];

  // Latency metrics (debug logging only)
  private turnStartTime = 0;
  private firstTokenTime: number | null = null;
  private firstTtsRequestTime: number | null = null;
  private firstTtsAudioReadyTime: number | null = null;
  private firstAudioPlaybackTime: number | null = null;

  private host: TtsPipelineHost = NOOP_TTS_HOST;

  /** Connects the voice session. Called again after every render so callbacks always see the latest logic. */
  attachHost(host: TtsPipelineHost): void {
    this.host = host;
  }

  // ---- read-only views for diagnostics ----
  get inFlight() { return this.inFlightCount; }
  get audioReadyDepth() { return this.audioReady.size; }
  get currentPlaySeq() { return this.currentPlaySequence; }
  get playingAudio() { return this.currentAudio; }

  /** Invalidates the current turn: in-flight fetches and pending audio callbacks from it will be discarded. */
  invalidateTurn(): void {
    this.activeTurnId++;
  }

  /** Begins a new turn: resets the whole pipeline and returns the new turn id. */
  startTurn(): number {
    const turnId = ++this.activeTurnId;
    this.turnStartTime = performance.now();
    this.firstTokenTime = null;
    this.firstTtsRequestTime = null;
    this.firstTtsAudioReadyTime = null;
    this.firstAudioPlaybackTime = null;
    this.previousChunkAudioEndTime = null;
    this.processedSpeechLength = 0;
    this.ttsSequenceCounter = 0;
    this.currentPlaySequence = 0;
    this.ttsQueue = [];
    this.audioReady.clear();
    this.inFlightCount = 0;
    this.isStreamComplete = false;
    this.currentChunkText = "";
    return turnId;
  }

  /** Idempotent: aborts in-flight fetches, stops audio, revokes object URLs and empties the queues. */
  cleanup(): void {
    debugLog("[AUDIO] Cleaning up audio resources, in-flight fetches, and queues");

    // Abort all active in-flight TTS fetch requests
    this.abortControllers.forEach((controller) => {
      try {
        controller.abort();
      } catch {}
    });
    this.abortControllers = [];

    if (this.currentAudio) {
      try {
        this.currentAudio.onplay = null;
        this.currentAudio.onended = null;
        this.currentAudio.onerror = null;
        this.currentAudio.onloadedmetadata = null;
        this.currentAudio.oncanplay = null;
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch {}
      this.currentAudio = null;
    }

    if (this.currentAudioUrl) {
      try {
        URL.revokeObjectURL(this.currentAudioUrl);
      } catch {}
      this.currentAudioUrl = null;
    }

    // Revoke all queued audio chunks
    this.audioReady.forEach((chunk) => {
      try {
        URL.revokeObjectURL(chunk.objectUrl);
      } catch {}
    });
    this.audioReady.clear();

    this.ttsQueue = [];
    this.inFlightCount = 0;
    this.isPlaying = false;
    this.previousChunkAudioEndTime = null;
    this.currentChunkText = "";
  }

  /** Stops playback and discards the turn (user interruption or a new utterance). */
  interrupt(): void {
    debugLog("[interruptPlayback] Stopping audio playback and purging pipeline");
    this.activeTurnId++;
    this.cleanup();
    this.cancelSpeechSynthesis();
  }

  /** Cancels any browser speechSynthesis fallback speech. */
  cancelSpeechSynthesis(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  }

  /**
   * Feeds the assistant's (possibly still streaming) reply. New complete speech chunks are queued and dispatched;
   * once the stream is complete the remainder is flushed and the pipeline is told no more chunks are coming.
   */
  feedAssistantText(fullContent: string, isComplete: boolean): void {
    if (this.firstTokenTime === null && fullContent.length > 0) {
      this.firstTokenTime = performance.now();
      const firstTokenMs = (this.firstTokenTime - this.turnStartTime).toFixed(1);
      debugLog(`[VOICE STREAM] LLM chunk received (llm_first_token_ms = ${firstTokenMs}ms)`);
    }

    // Convert raw markdown into natural spoken language (stripping code blocks, markdown symbols, and LaTeX)
    const sanitizedSpeech = sanitizeTextForTTS(fullContent);

    // Extract small, natural sentence/clause chunks (~40-80 chars) from sanitized speech
    const extractedChunks = extractStreamingTTSChunks(sanitizedSpeech, this.processedSpeechLength, isComplete);

    if (extractedChunks.length > 0) {
      for (const chunk of extractedChunks) {
        this.processedSpeechLength += chunk.rawLength;
        const seq = this.ttsSequenceCounter++;
        this.ttsQueue.push({ seq, text: chunk.text });
      }
      this.processQueue(this.activeTurnId);
    }

    if (isComplete) {
      this.isStreamComplete = true;
      this.processQueue(this.activeTurnId);
    }
  }

  /** Developer test button: speaks one fixed sentence outside the conversation pipeline. */
  async playTestSound(): Promise<void> {
    debugLog("=== MANUAL TEST TTS AUDIO PLAYBACK TRIGGERED ===");
    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };

      const testPrompt = "This is a direct test of Lumina Kokoro audio playback.";
      const res = await fetch(`${API_BASE_URL}/tts`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ text: testPrompt }),
      });

      if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      audio.volume = 1.0;
      audio.muted = false;

      audio.onended = () => URL.revokeObjectURL(objectUrl);
      audio.onerror = () => URL.revokeObjectURL(objectUrl);

      await audio.play();
      debugLog("[AUDIO Test] play() resolved successfully");
    } catch (err) {
      console.error("[AUDIO Test] Rejection/Error:", err);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Queue lifecycle: processQueue() dispatches queued text to fetchChunk() (at most MAX_IN_FLIGHT_TTS at a time);
  // each finished fetch stores its audio under its sequence number and calls playNext(), which only ever plays the
  // NEXT sequence number, so playback order equals chunk order regardless of which request finishes first. When a
  // chunk ends (or fails) the sequence advances and both functions run again.
  // ---------------------------------------------------------------------------------------------------------------

  /** Bounded TTS queue dispatcher. */
  private processQueue(turnId: number): void {
    if (turnId !== this.activeTurnId || !this.host.isVoiceActive()) return;

    while (this.inFlightCount < MAX_IN_FLIGHT_TTS && this.ttsQueue.length > 0) {
      const item = this.ttsQueue.shift();
      if (!item) break;

      if (!isMeaningfulSpeechChunk(item.text)) {
        continue;
      }

      this.inFlightCount++;
      void this.fetchChunk(turnId, item.seq, item.text);
    }

    this.playNext(turnId);
  }

  /** TTS fetch worker for one chunk, cancellable through its AbortController. */
  private async fetchChunk(turnId: number, seq: number, text: string): Promise<void> {
    if (turnId !== this.activeTurnId || !this.host.isVoiceActive()) return;

    const ttsStartMs = performance.now();
    if (this.firstTtsRequestTime === null) {
      this.firstTtsRequestTime = ttsStartMs;
      const firstReqMs = (ttsStartMs - this.turnStartTime).toFixed(1);
      debugLog(`[VOICE STREAM] First TTS request dispatched (first_tts_request_ms = ${firstReqMs}ms)`);
    }

    const abortController = new AbortController();
    this.abortControllers.push(abortController);

    debugLog(`[TTS PRODUCER -> /tts seq=#${seq}] "${text}" (${text.length} chars) | in_flight=${this.inFlightCount}`);

    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };

      const res = await fetch(`${API_BASE_URL}/tts`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ text }),
        signal: abortController.signal,
      });

      if (turnId !== this.activeTurnId || !this.host.isVoiceActive()) {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        return;
      }

      if (!res.ok) throw new Error(`TTS HTTP error ${res.status}`);

      const blob = await res.blob();
      const ttsEndMs = performance.now();
      const ttsDurationMs = ttsEndMs - ttsStartMs;

      if (turnId !== this.activeTurnId || !this.host.isVoiceActive()) {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        return;
      }

      if (this.firstTtsAudioReadyTime === null) {
        this.firstTtsAudioReadyTime = ttsEndMs;
        const firstReadyMs = (ttsEndMs - this.turnStartTime).toFixed(1);
        debugLog(`>>> [FIRST AUDIO READY] Latency: ${firstReadyMs}ms | Audio size: ${blob.size} bytes <<<`);
      }

      const objectUrl = URL.createObjectURL(blob);
      debugLog(
        `[TTS SYNTHESIZED seq=#${seq}] Duration: ${(ttsDurationMs / 1000).toFixed(2)}s | ` +
        `Audio Size: ${blob.size} bytes | chars=${text.length}`
      );

      this.audioReady.set(seq, {
        seq,
        objectUrl,
        text,
        chars: text.length,
        ttsStartMs,
        ttsEndMs,
        ttsDurationMs,
        audioQueuedMs: performance.now(),
      });

      this.inFlightCount = Math.max(0, this.inFlightCount - 1);

      if (!this.host.isVoiceActive() || turnId !== this.activeTurnId) return;

      // Trigger audio player consumer
      this.playNext(turnId);

      // Trigger next prefetch task if slots are open
      this.processQueue(turnId);
    } catch (err) {
      if (isAbortError(err) || turnId !== this.activeTurnId || !this.host.isVoiceActive()) {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        return;
      }
      console.warn(`[VOICE STREAM] TTS fetch failed for seq=#${seq}:`, err);
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      if (this.currentPlaySequence === seq) {
        this.currentPlaySequence++;
      }
      if (this.host.isVoiceActive() && turnId === this.activeTurnId) {
        this.playNext(turnId);
        this.processQueue(turnId);
      }
    } finally {
      this.abortControllers = this.abortControllers.filter((c) => c !== abortController);
    }
  }

  /** Audio queue consumer: plays chunks in strict sequential order (0 -> 1 -> 2 -> ...). */
  private playNext(turnId: number): void {
    if (turnId !== this.activeTurnId || !this.host.isVoiceActive()) return;
    if (this.isPlaying) return;

    const targetSeq = this.currentPlaySequence;

    if (this.audioReady.has(targetSeq)) {
      const chunk = this.audioReady.get(targetSeq)!;
      this.audioReady.delete(targetSeq);

      const now = performance.now();
      if (this.previousChunkAudioEndTime !== null) {
        const audioGapMs = now - this.previousChunkAudioEndTime;
        debugLog(
          `[AUDIO CONTINUATION] seq=#${chunk.seq} | audio_gap_ms=${audioGapMs.toFixed(1)}ms | ` +
          `audio_ready_depth=${this.audioReady.size} | in_flight_tts=${this.inFlightCount}`
        );
      }

      this.isPlaying = true;
      this.currentChunkText = chunk.text;
      this.host.onChunkPlaybackStart();

      const audio = new Audio(chunk.objectUrl);
      audio.volume = 1.0;
      audio.muted = false;
      this.currentAudio = audio;
      this.currentAudioUrl = chunk.objectUrl;

      let playbackStartTime = 0;

      audio.onloadedmetadata = () => {
        debugLog(`[AUDIO] onloadedmetadata (seq=#${chunk.seq}): duration=${audio.duration}s`);
      };

      audio.onplay = () => {
        playbackStartTime = performance.now();
        if (this.firstAudioPlaybackTime === null) {
          this.firstAudioPlaybackTime = playbackStartTime;
          const firstPlayLatency = (this.firstAudioPlaybackTime - this.turnStartTime).toFixed(1);
          debugLog(`[VOICE STREAM] First audio playback started (first_audio_playback_ms = ${firstPlayLatency}ms) | seq=#${chunk.seq}`);
        } else {
          debugLog(`[VOICE STREAM] Playing audio chunk seq=#${chunk.seq} ("${chunk.text}")`);
        }
      };

      audio.onended = () => {
        if (turnId !== this.activeTurnId || !this.host.isVoiceActive()) return;
        const playbackEndTime = performance.now();
        const audioDurationSec = ((playbackEndTime - playbackStartTime) / 1000).toFixed(2);
        debugLog(`[VOICE STREAM] Audio chunk seq=#${chunk.seq} ended (duration=${audioDurationSec}s)`);

        this.previousChunkAudioEndTime = performance.now();
        this.currentChunkText = "";
        URL.revokeObjectURL(chunk.objectUrl);
        if (this.currentAudioUrl === chunk.objectUrl) {
          this.currentAudioUrl = null;
        }
        this.currentAudio = null;
        this.isPlaying = false;
        this.currentPlaySequence++;

        // Immediately trigger next chunk in sequence!
        this.playNext(turnId);
      };

      audio.onerror = (e) => {
        if (turnId !== this.activeTurnId || !this.host.isVoiceActive()) return;
        console.error(`[AUDIO] onerror (seq=#${chunk.seq}):`, e);
        this.previousChunkAudioEndTime = performance.now();
        this.currentChunkText = "";
        URL.revokeObjectURL(chunk.objectUrl);
        if (this.currentAudioUrl === chunk.objectUrl) {
          this.currentAudioUrl = null;
        }
        this.currentAudio = null;
        this.isPlaying = false;
        this.currentPlaySequence++;
        this.playNext(turnId);
      };

      audio.play().catch((playErr) => {
        if (isAbortError(playErr) || turnId !== this.activeTurnId || !this.host.isVoiceActive()) {
          return;
        }
        console.error(`[AUDIO] play() rejected for seq=#${chunk.seq}:`, playErr);
        this.currentChunkText = "";
        URL.revokeObjectURL(chunk.objectUrl);
        this.currentAudio = null;
        this.isPlaying = false;
        this.currentPlaySequence++;
        this.playNext(turnId);
      });
    } else {
      // Check if all chunks have finished both generation and playback
      const allSynthesized =
        this.isStreamComplete &&
        this.ttsQueue.length === 0 &&
        this.inFlightCount === 0 &&
        targetSeq >= this.ttsSequenceCounter;

      if (allSynthesized) {
        debugLog("[VOICE STREAM] All audio chunks completed naturally");
        const totalDuration = (performance.now() - this.turnStartTime).toFixed(1);
        debugLog(`[VOICE STREAM] total_response_ms = ${totalDuration}ms`);

        this.isPlaying = false;
        this.currentChunkText = "";
        this.host.onAllChunksPlayed();
      } else {
        // Starvation diagnostic logging
        debugLog(
          `[AUDIO STARVATION] seq=#${targetSeq} | reason="TTS still synthesizing" | ` +
          `in_flight=${this.inFlightCount} | pending_text_queue=${this.ttsQueue.length} | audio_ready_count=${this.audioReady.size}`
        );
      }
    }
  }
}
