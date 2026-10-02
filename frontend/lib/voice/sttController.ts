/**
 * SpeechRecognition (STT) controller: owns the recognizer instance and everything that must stay consistent about it.
 *
 * It is a plain class holding the CURRENT recognizer, session id and transcript bookkeeping, so event handlers never
 * see stale values. Every recognizer gets a session id; events from a replaced/stopped recognizer are ignored.
 * What a transcript or an error MEANS for the conversation (wake word, interruption, submit, error messages, restart
 * policy) is decided by the voice session through `SttHost`.
 *
 * Microphone privacy: this controller never starts anything by itself. `begin()` is only called by the voice session
 * in response to an explicit user action (voice mode, wake-word opt-in, the mic button).
 */
import { debugLog } from "@/lib/debug";
import type { SpeechRecognitionInstance } from "@/types/speech";

/** Decisions delegated to the voice session. Called after the controller's own bookkeeping. */
export interface SttHost {
  /** The recognizer really started / stopped capturing audio. */
  onMicActiveChange(active: boolean): void;
  /** The current recognizer started. */
  onStarted(): void;
  /** New transcript text for the current turn (interim or final). */
  onTranscript(fullText: string, sessionId: number): void;
  /** The current recognizer reported an error other than the benign "no-speech". */
  onError(error: string): void;
  /** The current recognizer ended by itself (silence timeout, network, browser decision). */
  onEnded(sessionId: number): void;
  /** The browser has no SpeechRecognition. */
  onUnsupported(): void;
  /** Creating or starting the recognizer threw. */
  onStartFailed(err: unknown): void;
}

const NOOP_STT_HOST: SttHost = {
  onMicActiveChange: () => {},
  onStarted: () => {},
  onTranscript: () => {},
  onError: () => {},
  onEnded: () => {},
  onUnsupported: () => {},
  onStartFailed: () => {},
};

export class SttController {
  recognition: SpeechRecognitionInstance | null = null;
  /** Id of the current recognizer; bumped for every new one and when the session is invalidated. */
  sessionId = 0;
  isListening = false;
  isStarting = false;

  // Per-turn transcript isolation: only results from the current conversational turn are used
  latestTranscript = "";
  private turnStartResultIndex = 0;
  private lastResultsLength = 0;

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private host: SttHost = NOOP_STT_HOST;

  /** Connects the voice session. Called again after every render so callbacks always see the latest logic. */
  attachHost(host: SttHost): void {
    this.host = host;
  }

  get hasRecognition(): boolean {
    return this.recognition !== null;
  }

  /** Creates and starts a recognizer, replacing any existing one. */
  begin(): void {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      this.host.onUnsupported();
      return;
    }

    try {
      this.stop();

      const sessionId = ++this.sessionId;
      this.resetTurn();
      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      recognition.onstart = () => {
        if (this.sessionId !== sessionId) return;
        debugLog(`[STT] recognition.onstart (sessionId=${sessionId})`);
        this.host.onMicActiveChange(true);
        this.isListening = true;
        this.isStarting = false;
        this.host.onStarted();
      };

      recognition.onresult = (event) => {
        if (this.sessionId !== sessionId) return;

        this.lastResultsLength = event.results.length;

        let currentFinal = "";
        let currentInterim = "";

        // Only process results from the current conversational turn
        const startIdx = Math.min(this.turnStartResultIndex, event.results.length);
        for (let i = startIdx; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            currentFinal += res[0].transcript;
          } else {
            currentInterim += res[0].transcript;
          }
        }

        const fullText = (currentFinal + " " + currentInterim).trim();
        this.latestTranscript = fullText;
        this.host.onTranscript(fullText, sessionId);
      };

      recognition.onerror = (event) => {
        if (this.sessionId !== sessionId) return;
        debugLog(`[STT] recognition.onerror (${event.error})`);
        this.isStarting = false;
        if (event.error === "no-speech") {
          // Benign silence in continuous mode — do not abort listening
          return;
        }
        this.isListening = false;
        this.host.onError(event.error);
      };

      recognition.onend = () => {
        debugLog(`[STT] recognition.onend (sessionId=${sessionId}, activeSessionId=${this.sessionId})`);
        this.isStarting = false;
        if (this.sessionId !== sessionId) {
          debugLog("[STT] Ignoring onend from stale SpeechRecognition instance.");
          return;
        }

        this.host.onMicActiveChange(false);
        this.isListening = false;
        this.host.onEnded(sessionId);
      };

      this.recognition = recognition;
      debugLog(`[STT] starting recognition (sessionId=${sessionId})`);
      this.isStarting = true;
      recognition.start();
    } catch (err) {
      console.warn("[useVoiceConversation] Failed to start speech recognition:", err);
      this.isStarting = false;
      this.isListening = false;
      this.host.onStartFailed(err);
    }
  }

  /** Stops and releases the recognizer: detaches its handlers first so a late event cannot restart anything. */
  stop(): void {
    debugLog("[STT] Stopping SpeechRecognition");
    this.host.onMicActiveChange(false);
    this.isListening = false;
    this.isStarting = false;

    this.clearSilenceTimer();

    if (this.recognition) {
      try {
        this.recognition.onstart = null;
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.abort();
      } catch {}
      this.recognition = null;
    }
  }

  /** Makes every handler of the current recognizer stale (used when voice mode is torn down). */
  invalidateSession(): void {
    this.sessionId++;
  }

  /** Forgets the current turn's transcript and result bookkeeping. */
  resetTurn(): void {
    this.turnStartResultIndex = 0;
    this.lastResultsLength = 0;
    this.latestTranscript = "";
  }

  /** The current utterance was submitted: later results belong to the next turn. */
  beginNextTurn(): void {
    this.latestTranscript = "";
    this.turnStartResultIndex = this.lastResultsLength;
  }

  /** Runs `onSilence` once after `ms` without being re-armed; replaces any pending timer. */
  armSilenceTimer(ms: number, onSilence: () => void): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(onSilence, ms);
  }

  clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /** Development bridge: feeds a final result into the live recognizer as if it had been spoken. */
  simulateResult(text: string): void {
    const recognition = this.recognition;
    if (recognition && recognition.onresult) {
      recognition.onresult({
        results: [Object.assign([{ transcript: text, confidence: 1.0 }], { isFinal: true })],
      } as unknown as Parameters<NonNullable<SpeechRecognitionInstance["onresult"]>>[0]);
    }
  }
}
