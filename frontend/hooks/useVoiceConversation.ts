import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Message } from "@/hooks/useChat";
import { detectIntent, IntentResult } from "@/lib/intentDetector";
import { sanitizeTextForTTS, parseWakeWord, isInterruptionCommand } from "@/lib/speechSanitizer";
import Cookies from "js-cookie";

export type VoiceState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ACTION" | "ERROR";

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

interface UseVoiceConversationProps {
  sendMessage: (content: string, file?: File | null, isVoice?: boolean) => Promise<void> | void;
  stopGeneration: () => void;
  isLoading: boolean;
  messages: Message[];
  isOpen: boolean;
  hasDocument?: boolean;
  enableWakeWord?: boolean;
  onOpenVoiceMode?: () => void;
}

const MAX_IN_FLIGHT_TTS = 2;

/**
 * Verifies that a text chunk contains meaningful natural language words.
 */
export function isMeaningfulSpeechChunk(chunk: string): boolean {
  if (!chunk || chunk.trim().length < 3) return false;
  const hasWord = /[a-zA-Z]{2,}/.test(chunk);
  if (!hasWord) return false;

  const strippedOfSymbols = chunk.replace(/[^a-zA-Z0-9]/g, "");
  if (strippedOfSymbols.length < 2) return false;

  return true;
}

/**
 * Hybrid streaming speech chunker.
 * Targets small natural speech units (~40-80 chars, or complete short clauses/sentences)
 * to ensure first audio latency is fast while preserving natural phrasing.
 */
function extractStreamingTTSChunks(
  sanitizedText: string,
  processedLen: number,
  isComplete: boolean
): { text: string; rawLength: number }[] {
  const chunks: { text: string; rawLength: number }[] = [];
  let remaining = sanitizedText.slice(processedLen);
  let advancedLen = 0;

  while (remaining.length > 0) {
    if (remaining.length < 35 && !isComplete) {
      break;
    }

    // 1. Look for sentence or clause boundaries (. ? ! ; : ,) between 35 and 90 chars
    const punctRegex = /([.?!;]+|:\s+|,|\n+)/g;
    let match: RegExpExecArray | null;
    let foundSplitIdx = -1;

    while ((match = punctRegex.exec(remaining)) !== null) {
      const idxAfter = match.index + match[0].length;
      if (idxAfter >= 35 && idxAfter <= 90) {
        foundSplitIdx = idxAfter;
        break;
      }
      if (idxAfter > 90) {
        break;
      }
    }

    if (foundSplitIdx !== -1) {
      const candidate = remaining.slice(0, foundSplitIdx).trim();
      advancedLen += foundSplitIdx;
      remaining = remaining.slice(foundSplitIdx);
      if (isMeaningfulSpeechChunk(candidate)) {
        chunks.push({ text: candidate, rawLength: advancedLen });
        advancedLen = 0;
      }
      continue;
    }

    // 2. Length-based boundary: if text reaches >= 65 chars without punctuation split,
    // split at the nearest whitespace between 35 and 80 chars
    if (remaining.length >= 65) {
      const searchLimit = Math.min(80, remaining.length);
      const lastSpaceIdx = remaining.lastIndexOf(" ", searchLimit);
      if (lastSpaceIdx >= 35) {
        const candidate = remaining.slice(0, lastSpaceIdx).trim();
        advancedLen += lastSpaceIdx + 1;
        remaining = remaining.slice(lastSpaceIdx + 1);
        if (isMeaningfulSpeechChunk(candidate)) {
          chunks.push({ text: candidate, rawLength: advancedLen });
          advancedLen = 0;
        }
        continue;
      }
    }

    // 3. Final remaining chunk when LLM stream is complete
    if (isComplete) {
      const candidate = remaining.trim();
      advancedLen += remaining.length;
      remaining = "";
      if (isMeaningfulSpeechChunk(candidate)) {
        chunks.push({ text: candidate, rawLength: advancedLen });
      }
      break;
    }

    break;
  }

  return chunks;
}

export function useVoiceConversation({
  sendMessage,
  stopGeneration,
  isLoading,
  messages,
  isOpen,
  hasDocument = false,
  enableWakeWord = true,
  onOpenVoiceMode,
}: UseVoiceConversationProps) {
  const router = useRouter();
  const [voiceState, setVoiceState] = useState<VoiceState>("IDLE");
  const [transcript, setTranscript] = useState("");
  const [isLoopEnabled, setIsLoopEnabled] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Stable callback prop refs
  const onOpenVoiceModeRef = useRef(onOpenVoiceMode);
  onOpenVoiceModeRef.current = onOpenVoiceMode;

  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const stopGenerationRef = useRef(stopGeneration);
  stopGenerationRef.current = stopGeneration;

  // Recognition & Session refs
  const recognitionRef = useRef<any>(null);
  const activeSessionIdRef = useRef<number>(0);
  const activeTurnIdRef = useRef<number>(0);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const actionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastWakeTriggerTimeRef = useRef<number>(0);

  // Per-turn speech transcript isolation refs
  const turnStartResultIndexRef = useRef<number>(0);
  const lastResultsLengthRef = useRef<number>(0);
  const latestTranscriptRef = useRef<string>("");
  const startListeningRef = useRef<() => void>(() => {});

  // State Invariant & Lifecycle tracking refs
  const isListeningRef = useRef<boolean>(false);
  const isStartingRef = useRef<boolean>(false);
  const isLoopEnabledRef = useRef<boolean>(isLoopEnabled);
  const isPlayingAudioRef = useRef<boolean>(false);
  const isSubmittingRef = useRef<boolean>(false);
  const isVoiceActiveRef = useRef<boolean>(isOpen);
  const voiceStateRef = useRef<VoiceState>("IDLE");
  const currentPlayingChunkTextRef = useRef<string>("");

  // Bounded Prefetch Pipeline Refs
  const processedSpeechLengthRef = useRef<number>(0);
  const ttsSequenceCounterRef = useRef<number>(0);
  const ttsQueueRef = useRef<TTSQueueItem[]>([]);
  const inFlightTtsCountRef = useRef<number>(0);
  const audioReadyMapRef = useRef<Map<number, AudioChunk>>(new Map());
  const currentPlaySequenceRef = useRef<number>(0);
  const previousChunkAudioEndTimeRef = useRef<number | null>(null);
  const currentPlayingAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);
  const isStreamCompleteRef = useRef<boolean>(false);
  const activeAbortControllersRef = useRef<AbortController[]>([]);

  // Latency & Metrics Tracking
  const turnStartTimeRef = useRef<number>(0);
  const firstTokenTimeRef = useRef<number | null>(null);
  const firstTtsRequestTimeRef = useRef<number | null>(null);
  const firstTtsAudioReadyTimeRef = useRef<number | null>(null);
  const firstAudioPlaybackTimeRef = useRef<number | null>(null);

  const logStateTransition = useCallback((actionName: string) => {
    console.log(
      `[STATE TRANSITION - ${actionName}] voiceState=${voiceStateRef.current}, ` +
      `isListeningRef=${isListeningRef.current}, isPlayingAudioRef=${isPlayingAudioRef.current}, ` +
      `isVoiceActive=${isVoiceActiveRef.current}, recognitionRef=${!!recognitionRef.current}`
    );
  }, []);

  // Keep refs in sync
  useEffect(() => {
    isVoiceActiveRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    isLoopEnabledRef.current = isLoopEnabled;
  }, [isLoopEnabled]);

  useEffect(() => {
    voiceStateRef.current = voiceState;
    logStateTransition("voiceState=" + voiceState);
  }, [voiceState, logStateTransition]);

  // Idempotent audio resource cleanup
  const cleanupAudioResources = useCallback(() => {
    console.log("[AUDIO] Cleaning up audio resources, in-flight fetches, and queues");

    // Abort all active in-flight TTS fetch requests
    activeAbortControllersRef.current.forEach((controller) => {
      try {
        controller.abort();
      } catch {}
    });
    activeAbortControllersRef.current = [];

    if (currentPlayingAudioRef.current) {
      try {
        currentPlayingAudioRef.current.onplay = null;
        currentPlayingAudioRef.current.onended = null;
        currentPlayingAudioRef.current.onerror = null;
        currentPlayingAudioRef.current.onloadedmetadata = null;
        currentPlayingAudioRef.current.oncanplay = null;
        currentPlayingAudioRef.current.pause();
        currentPlayingAudioRef.current.currentTime = 0;
      } catch {}
      currentPlayingAudioRef.current = null;
    }

    if (currentAudioUrlRef.current) {
      try {
        URL.revokeObjectURL(currentAudioUrlRef.current);
      } catch {}
      currentAudioUrlRef.current = null;
    }

    // Revoke all queued audio chunks in audioReadyMap
    audioReadyMapRef.current.forEach((chunk) => {
      try {
        URL.revokeObjectURL(chunk.objectUrl);
      } catch {}
    });
    audioReadyMapRef.current.clear();

    ttsQueueRef.current = [];
    inFlightTtsCountRef.current = 0;
    isPlayingAudioRef.current = false;
    previousChunkAudioEndTimeRef.current = null;
    currentPlayingChunkTextRef.current = "";
  }, []);

  // Stop STT recognition
  const stopSTT = useCallback(() => {
    console.log("[STT] Stopping SpeechRecognition");
    isListeningRef.current = false;
    isStartingRef.current = false;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.onstart = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.abort();
      } catch {}
      recognitionRef.current = null;
    }
  }, []);

  // Interruption / Stop
  const interruptPlayback = useCallback(() => {
    console.log("[interruptPlayback] Stopping audio playback and purging pipeline");
    activeTurnIdRef.current++;
    cleanupAudioResources();

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  }, [cleanupAudioResources]);

  // Full stop / abort handler
  const handleStop = useCallback(() => {
    console.log("[handleStop] User triggered full stop");
    activeTurnIdRef.current++;
    turnStartResultIndexRef.current = 0;
    lastResultsLengthRef.current = 0;
    latestTranscriptRef.current = "";
    stopSTT();
    interruptPlayback();
    stopGenerationRef.current();
    isSubmittingRef.current = false;
    setTranscript("");
    setActionFeedback(null);
    setVoiceState("IDLE");
  }, [stopSTT, interruptPlayback]);

  // Immediate Interruption Handler (for "stop", "Lumina stop", "stop Lumina")
  const handleImmediateInterruption = useCallback(
    (triggerPhrase: string): void => {
      console.log(`[INTERRUPTION] "${triggerPhrase}" detected -> IMMEDIATELY halting playback and LLM stream`);
      // Invalidate active turn so in-flight TTS responses are discarded
      activeTurnIdRef.current++;

      // Abort in-flight TTS fetches and clean up audio objects
      cleanupAudioResources();

      // Abort LLM stream
      stopGenerationRef.current();

      isSubmittingRef.current = false;
      setTranscript("");
      latestTranscriptRef.current = "";
      turnStartResultIndexRef.current = 0;
      lastResultsLengthRef.current = 0;
      setActionFeedback(null);

      // Clean restart into fresh LISTENING session
      stopSTT();
      setVoiceState("LISTENING");
      voiceStateRef.current = "LISTENING";
      setTimeout(() => {
        if (isVoiceActiveRef.current) {
          startListeningRef.current();
        }
      }, 100);
    },
    [cleanupAudioResources, stopSTT]
  );

  // Start STT Microphone Listener (Unified Single-Instance Implementation)
  const startListening = useCallback((): void => {
    if (typeof window === "undefined") return;

    // Guard against rapid duplicate clicks while recognition is initializing
    if (isStartingRef.current) {
      console.log("[startListening] Recognition is currently initializing, ignoring duplicate trigger.");
      return;
    }

    // If user clicks while assistant is actively speaking or generating, immediately interrupt and transition to listening
    if (isPlayingAudioRef.current || voiceStateRef.current === "SPEAKING" || voiceStateRef.current === "THINKING") {
      console.log("[startListening] Interrupting active playback/generation to start listening");
      interruptPlayback();
      stopGenerationRef.current();
      isSubmittingRef.current = false;
      setTranscript("");
      latestTranscriptRef.current = "";
      turnStartResultIndexRef.current = 0;
      lastResultsLengthRef.current = 0;
      setActionFeedback(null);
    }

    if (isListeningRef.current && recognitionRef.current) {
      if (isVoiceActiveRef.current && voiceStateRef.current === "LISTENING") {
        console.log("[startListening] Recognition is already active and in LISTENING state.");
        return;
      }
      console.log("[startListening] Transitioning active recognition into LISTENING state");
      stopSTT();
      if (isVoiceActiveRef.current) {
        setVoiceState("LISTENING");
        voiceStateRef.current = "LISTENING";
        setTranscript("");
      }
      setTimeout(() => {
        startListening();
      }, 100);
      return;
    }

    setErrorMessage(null);

    const SpeechRecognitionClass =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      setErrorMessage("Voice input is not supported in this browser.");
      setVoiceState("ERROR");
      return;
    }

    try {
      stopSTT();

      const sessionId = ++activeSessionIdRef.current;
      turnStartResultIndexRef.current = 0;
      lastResultsLengthRef.current = 0;
      latestTranscriptRef.current = "";
      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      recognition.onstart = () => {
        if (activeSessionIdRef.current !== sessionId) return;
        console.log(`[STT] recognition.onstart (sessionId=${sessionId}, isVoiceActive=${isVoiceActiveRef.current})`);
        isListeningRef.current = true;
        isStartingRef.current = false;
        if (isVoiceActiveRef.current) {
          if (!isPlayingAudioRef.current && voiceStateRef.current !== "THINKING" && voiceStateRef.current !== "SPEAKING") {
            setVoiceState("LISTENING");
            voiceStateRef.current = "LISTENING";
          }
        }
      };

      recognition.onresult = (event: any) => {
        if (activeSessionIdRef.current !== sessionId) return;

        lastResultsLengthRef.current = event.results.length;

        let currentFinal = "";
        let currentInterim = "";

        // Only process results from the current conversational turn
        const startIdx = Math.min(turnStartResultIndexRef.current, event.results.length);
        for (let i = startIdx; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            currentFinal += res[0].transcript;
          } else {
            currentInterim += res[0].transcript;
          }
        }

        const fullText = (currentFinal + " " + currentInterim).trim();
        latestTranscriptRef.current = fullText;

        // SCENARIO 1: Dashboard Idle Wake-Word Mode (isOpen is false)
        if (!isVoiceActiveRef.current) {
          if (enableWakeWord && fullText.length >= 2) {
            const { isWake, prompt } = parseWakeWord(fullText);
            if (isWake) {
              const now = Date.now();
              if (now - lastWakeTriggerTimeRef.current < 2000) {
                return; // Debounce repeated triggers
              }
              lastWakeTriggerTimeRef.current = now;
              console.log(`[WAKE WORD DETECTED] "Lumina" heard! Trailing prompt="${prompt}"`);

              onOpenVoiceModeRef.current?.();

              if (prompt.length >= 2) {
                console.log(`[WAKE WORD] Immediate question found: "${prompt}" -> auto-submitting`);
                setTimeout(() => {
                  submitTranscript(prompt);
                }, 100);
              } else {
                console.log(`[WAKE WORD] Wake word only -> ready for user question`);
                setVoiceState("LISTENING");
                voiceStateRef.current = "LISTENING";
              }
            }
          }
          return;
        }

        // SCENARIO 2: In Voice Mode while Assistant is SPEAKING or THINKING (Interruption Monitoring)
        if (voiceStateRef.current === "SPEAKING" || voiceStateRef.current === "THINKING" || isPlayingAudioRef.current) {
          if (isInterruptionCommand(fullText, currentPlayingChunkTextRef.current)) {
            handleImmediateInterruption(fullText);
          }
          return;
        }

        // SCENARIO 3: In Voice Mode while LISTENING (Normal Speech Capture)
        if (voiceStateRef.current === "LISTENING" && !isSubmittingRef.current) {
          if (fullText.length >= 1) {
            setTranscript(fullText);

            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
            }

            if (fullText.length >= 2) {
              silenceTimerRef.current = setTimeout(() => {
                if (
                  activeSessionIdRef.current === sessionId &&
                  isVoiceActiveRef.current &&
                  voiceStateRef.current === "LISTENING" &&
                  !isSubmittingRef.current
                ) {
                  console.log("[STT] silence detected, auto-submitting transcript:", latestTranscriptRef.current);
                  submitTranscript(latestTranscriptRef.current);
                }
              }, 1500);
            }
          }
        }
      };

      recognition.onerror = (event: any) => {
        if (activeSessionIdRef.current !== sessionId) return;
        console.log(`[STT] recognition.onerror (${event.error})`);
        isStartingRef.current = false;
        if (event.error === "no-speech") {
          // Benign silence in continuous mode — do not abort listening
          return;
        }
        isListeningRef.current = false;
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setErrorMessage("Microphone access was blocked. Please allow microphone permissions in your browser URL bar.");
          if (isVoiceActiveRef.current) {
            setVoiceState("ERROR");
          }
          stopSTT();
        } else if (event.error === "audio-capture") {
          setErrorMessage("No microphone detected. Please plug in or select a microphone and try again.");
          if (isVoiceActiveRef.current) {
            setVoiceState("ERROR");
          }
          stopSTT();
        } else if (event.error === "network") {
          setErrorMessage("Voice recognition network error. Please check your internet connection.");
          if (isVoiceActiveRef.current) {
            setVoiceState("ERROR");
          }
        } else if (event.error !== "aborted") {
          if (isVoiceActiveRef.current) {
            setErrorMessage(`Voice recognition encountered an issue (${event.error}). Tap to retry.`);
            setVoiceState("ERROR");
          }
        }
      };

      recognition.onend = () => {
        console.log(`[STT] recognition.onend (sessionId=${sessionId}, activeSessionId=${activeSessionIdRef.current}, isVoiceActive=${isVoiceActiveRef.current})`);
        isStartingRef.current = false;
        if (activeSessionIdRef.current !== sessionId) {
          console.log("[STT] Ignoring onend from stale SpeechRecognition instance.");
          return;
        }

        isListeningRef.current = false;

        // Auto-restart recognition based on active state
        if (isVoiceActiveRef.current) {
          if (voiceStateRef.current === "LISTENING") {
            if (latestTranscriptRef.current.trim().length >= 2 && !isSubmittingRef.current) {
              submitTranscript(latestTranscriptRef.current);
            } else if (!isSubmittingRef.current && isLoopEnabledRef.current) {
              setTimeout(() => {
                if (
                  activeSessionIdRef.current === sessionId &&
                  isVoiceActiveRef.current &&
                  (voiceStateRef.current === "LISTENING" || voiceStateRef.current === "IDLE")
                ) {
                  startListening();
                }
              }, 200);
            } else {
              setVoiceState("IDLE");
            }
          } else if (voiceStateRef.current === "THINKING" || voiceStateRef.current === "SPEAKING") {
            // Keep listening for interruptions during speech/synthesis
            setTimeout(() => {
              if (
                activeSessionIdRef.current === sessionId &&
                isVoiceActiveRef.current &&
                (voiceStateRef.current === "THINKING" || voiceStateRef.current === "SPEAKING")
              ) {
                startListening();
              }
            }, 200);
          }
        } else if (enableWakeWord) {
          // Keep listening for wake word on Dashboard
          setTimeout(() => {
            if (activeSessionIdRef.current === sessionId && !isVoiceActiveRef.current && enableWakeWord) {
              startListening();
            }
          }, 300);
        }
      };

      recognitionRef.current = recognition;
      console.log(`[STT] starting recognition (sessionId=${sessionId}, isVoiceActive=${isVoiceActiveRef.current})`);
      isStartingRef.current = true;
      recognition.start();
    } catch (err: any) {
      console.warn("[useVoiceConversation] Failed to start speech recognition:", err);
      isStartingRef.current = false;
      isListeningRef.current = false;
      if (isVoiceActiveRef.current) {
        setErrorMessage("Failed to activate microphone. Tap to retry.");
        setVoiceState("ERROR");
      }
    }
  }, [stopSTT, isLoopEnabled, enableWakeWord, handleImmediateInterruption]);
  startListeningRef.current = startListening;

  // Immediate Voice Mode Exit Handler (Immediate, race-free termination)
  const exitVoiceMode = useCallback(() => {
    console.log("[exitVoiceMode] Immediately stopping ALL voice activity and invalidating session");

    // 1. Mark voice inactive FIRST to prevent any pending async actions or callbacks
    isVoiceActiveRef.current = false;

    // 2. Invalidate active session and active turn immediately
    activeSessionIdRef.current++;
    activeTurnIdRef.current++;

    // 3. Stop STT recognition immediately (removes handlers and aborts)
    stopSTT();

    // 4. Clean up all audio resources (pauses current audio, nullifies ref, revokes blob URLs, clears audio queues, aborts in-flight /tts fetches)
    cleanupAudioResources();

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }

    // 5. Abort active LLM generation stream
    stopGenerationRef.current();

    // 6. Clear any pending silence or action timers
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (actionTimerRef.current) {
      clearTimeout(actionTimerRef.current);
      actionTimerRef.current = null;
    }

    // 7. Reset submission state, transcript, and UI feedback
    isSubmittingRef.current = false;
    setTranscript("");
    latestTranscriptRef.current = "";
    turnStartResultIndexRef.current = 0;
    lastResultsLengthRef.current = 0;
    setActionFeedback(null);
    setVoiceState("IDLE");

    // 8. If wake word is enabled on Dashboard, restart wake-word listener after cleanup
    if (enableWakeWord) {
      console.log("[exitVoiceMode] Scheduling clean restart of Wake Word listener ('Lumina')");
      const currentSessionId = activeSessionIdRef.current;
      setTimeout(() => {
        if (!isVoiceActiveRef.current && activeSessionIdRef.current === currentSessionId && enableWakeWord) {
          startListening();
        }
      }, 200);
    }
  }, [stopSTT, cleanupAudioResources, enableWakeWord, startListening]);

  // Audio Queue Consumer: Plays audio chunks in strict sequential order (0 -> 1 -> 2 -> ...)
  const playNextAudioInQueue = useCallback((turnId: number) => {
    if (turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) return;
    if (isPlayingAudioRef.current) return;

    const targetSeq = currentPlaySequenceRef.current;

    if (audioReadyMapRef.current.has(targetSeq)) {
      const chunk = audioReadyMapRef.current.get(targetSeq)!;
      audioReadyMapRef.current.delete(targetSeq);

      const now = performance.now();
      if (previousChunkAudioEndTimeRef.current !== null) {
        const audioGapMs = now - previousChunkAudioEndTimeRef.current;
        console.log(
          `[AUDIO CONTINUATION] seq=#${chunk.seq} | audio_gap_ms=${audioGapMs.toFixed(1)}ms | ` +
          `audio_ready_depth=${audioReadyMapRef.current.size} | in_flight_tts=${inFlightTtsCountRef.current}`
        );
      }

      isPlayingAudioRef.current = true;
      currentPlayingChunkTextRef.current = chunk.text;
      setVoiceState("SPEAKING");

      // Ensure STT is active for interruption detection
      if (!isListeningRef.current) {
        startListening();
      }

      const audio = new Audio(chunk.objectUrl);
      audio.volume = 1.0;
      audio.muted = false;
      currentPlayingAudioRef.current = audio;
      currentAudioUrlRef.current = chunk.objectUrl;

      let playbackStartTime = 0;

      audio.onloadedmetadata = () => {
        console.log(`[AUDIO] onloadedmetadata (seq=#${chunk.seq}): duration=${audio.duration}s`);
      };

      audio.onplay = () => {
        playbackStartTime = performance.now();
        if (firstAudioPlaybackTimeRef.current === null) {
          firstAudioPlaybackTimeRef.current = playbackStartTime;
          const firstPlayLatency = (firstAudioPlaybackTimeRef.current - turnStartTimeRef.current).toFixed(1);
          console.log(`[VOICE STREAM] First audio playback started (first_audio_playback_ms = ${firstPlayLatency}ms) | seq=#${chunk.seq}`);
        } else {
          console.log(`[VOICE STREAM] Playing audio chunk seq=#${chunk.seq} ("${chunk.text}")`);
        }
      };

      audio.onended = () => {
        if (turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) return;
        const playbackEndTime = performance.now();
        const audioDurationSec = ((playbackEndTime - playbackStartTime) / 1000).toFixed(2);
        console.log(`[VOICE STREAM] Audio chunk seq=#${chunk.seq} ended (duration=${audioDurationSec}s)`);

        previousChunkAudioEndTimeRef.current = performance.now();
        currentPlayingChunkTextRef.current = "";
        URL.revokeObjectURL(chunk.objectUrl);
        if (currentAudioUrlRef.current === chunk.objectUrl) {
          currentAudioUrlRef.current = null;
        }
        currentPlayingAudioRef.current = null;
        isPlayingAudioRef.current = false;
        currentPlaySequenceRef.current++;

        // Immediately trigger next chunk in sequence!
        playNextAudioInQueue(turnId);
      };

      audio.onerror = (e) => {
        if (turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) return;
        console.error(`[AUDIO] onerror (seq=#${chunk.seq}):`, e);
        previousChunkAudioEndTimeRef.current = performance.now();
        currentPlayingChunkTextRef.current = "";
        URL.revokeObjectURL(chunk.objectUrl);
        if (currentAudioUrlRef.current === chunk.objectUrl) {
          currentAudioUrlRef.current = null;
        }
        currentPlayingAudioRef.current = null;
        isPlayingAudioRef.current = false;
        currentPlaySequenceRef.current++;
        playNextAudioInQueue(turnId);
      };

      audio.play().catch((playErr) => {
        if (playErr?.name === "AbortError" || turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) {
          return;
        }
        console.error(`[AUDIO] play() rejected for seq=#${chunk.seq}:`, playErr);
        currentPlayingChunkTextRef.current = "";
        URL.revokeObjectURL(chunk.objectUrl);
        currentPlayingAudioRef.current = null;
        isPlayingAudioRef.current = false;
        currentPlaySequenceRef.current++;
        playNextAudioInQueue(turnId);
      });
    } else {
      // Check if all chunks have finished both generation and playback
      const allSynthesized = (
        isStreamCompleteRef.current &&
        ttsQueueRef.current.length === 0 &&
        inFlightTtsCountRef.current === 0 &&
        targetSeq >= ttsSequenceCounterRef.current
      );

      if (allSynthesized) {
        console.log("[VOICE STREAM] All audio chunks completed naturally");
        const totalDuration = (performance.now() - turnStartTimeRef.current).toFixed(1);
        console.log(`[VOICE STREAM] total_response_ms = ${totalDuration}ms`);

        isPlayingAudioRef.current = false;
        currentPlayingChunkTextRef.current = "";
        setActionFeedback(null);
        isSubmittingRef.current = false;

        if (isVoiceActiveRef.current && isLoopEnabledRef.current) {
          console.log("[VOICE STREAM] All audio chunks completed naturally -> restarting clean listening turn");
          setVoiceState("LISTENING");
          voiceStateRef.current = "LISTENING";
          setTranscript("");
          latestTranscriptRef.current = "";
          turnStartResultIndexRef.current = 0;
          lastResultsLengthRef.current = 0;
          stopSTT();
          setTimeout(() => {
            if (isVoiceActiveRef.current) {
              startListening();
            }
          }, 100);
        } else {
          setVoiceState("IDLE");
        }
      } else {
        // Starvation diagnostic logging
        console.log(
          `[AUDIO STARVATION] seq=#${targetSeq} | reason="TTS still synthesizing" | ` +
          `in_flight=${inFlightTtsCountRef.current} | pending_text_queue=${ttsQueueRef.current.length} | audio_ready_count=${audioReadyMapRef.current.size}`
        );
      }
    }
  }, [startListening]);

  // TTS Fetch Worker for an individual chunk with AbortController support
  const fetchTtsChunk = useCallback(async (turnId: number, seq: number, text: string) => {
    if (turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) return;

    const ttsStartMs = performance.now();
    if (firstTtsRequestTimeRef.current === null) {
      firstTtsRequestTimeRef.current = ttsStartMs;
      const firstReqMs = (ttsStartMs - turnStartTimeRef.current).toFixed(1);
      console.log(`[VOICE STREAM] First TTS request dispatched (first_tts_request_ms = ${firstReqMs}ms)`);
    }

    const abortController = new AbortController();
    activeAbortControllersRef.current.push(abortController);

    console.log(`[TTS PRODUCER -> /tts seq=#${seq}] "${text}" (${text.length} chars) | in_flight=${inFlightTtsCountRef.current}`);

    try {
      const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const token = Cookies.get("token");
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${API_BASE_URL}/tts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text }),
        signal: abortController.signal,
      });

      if (turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) {
        inFlightTtsCountRef.current = Math.max(0, inFlightTtsCountRef.current - 1);
        return;
      }

      if (!res.ok) throw new Error(`TTS HTTP error ${res.status}`);

      const blob = await res.blob();
      const ttsEndMs = performance.now();
      const ttsDurationMs = ttsEndMs - ttsStartMs;

      if (turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) {
        inFlightTtsCountRef.current = Math.max(0, inFlightTtsCountRef.current - 1);
        return;
      }

      if (firstTtsAudioReadyTimeRef.current === null) {
        firstTtsAudioReadyTimeRef.current = ttsEndMs;
        const firstReadyMs = (ttsEndMs - turnStartTimeRef.current).toFixed(1);
        console.log(`>>> [FIRST AUDIO READY] Latency: ${firstReadyMs}ms | Audio size: ${blob.size} bytes <<<`);
      }

      const objectUrl = URL.createObjectURL(blob);
      console.log(
        `[TTS SYNTHESIZED seq=#${seq}] Duration: ${(ttsDurationMs / 1000).toFixed(2)}s | ` +
        `Audio Size: ${blob.size} bytes | chars=${text.length}`
      );

      audioReadyMapRef.current.set(seq, {
        seq,
        objectUrl,
        text,
        chars: text.length,
        ttsStartMs,
        ttsEndMs,
        ttsDurationMs,
        audioQueuedMs: performance.now(),
      });

      inFlightTtsCountRef.current = Math.max(0, inFlightTtsCountRef.current - 1);

      if (!isVoiceActiveRef.current || turnId !== activeTurnIdRef.current) return;

      // Trigger audio player consumer
      playNextAudioInQueue(turnId);

      // Trigger next prefetch task if slots are open
      processTtsQueue(turnId);
    } catch (err: any) {
      if (err?.name === "AbortError" || turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) {
        inFlightTtsCountRef.current = Math.max(0, inFlightTtsCountRef.current - 1);
        return;
      }
      console.warn(`[VOICE STREAM] TTS fetch failed for seq=#${seq}:`, err);
      inFlightTtsCountRef.current = Math.max(0, inFlightTtsCountRef.current - 1);
      if (currentPlaySequenceRef.current === seq) {
        currentPlaySequenceRef.current++;
      }
      if (isVoiceActiveRef.current && turnId === activeTurnIdRef.current) {
        playNextAudioInQueue(turnId);
        processTtsQueue(turnId);
      }
    } finally {
      activeAbortControllersRef.current = activeAbortControllersRef.current.filter((c) => c !== abortController);
    }
  }, [playNextAudioInQueue]);

  // Bounded TTS Queue Dispatcher
  const processTtsQueue = useCallback((turnId: number) => {
    if (turnId !== activeTurnIdRef.current || !isVoiceActiveRef.current) return;

    while (
      inFlightTtsCountRef.current < MAX_IN_FLIGHT_TTS &&
      ttsQueueRef.current.length > 0
    ) {
      const item = ttsQueueRef.current.shift();
      if (!item) break;

      if (!isMeaningfulSpeechChunk(item.text)) {
        continue;
      }

      inFlightTtsCountRef.current++;
      fetchTtsChunk(turnId, item.seq, item.text);
    }

    playNextAudioInQueue(turnId);
  }, [fetchTtsChunk, playNextAudioInQueue]);

  // Submit speech transcript through Intent & Action Router
  const submitTranscript = useCallback(
    async (textToSubmit: string) => {
      const clean = textToSubmit.trim();
      if (!clean || clean.length < 2 || isSubmittingRef.current) {
        return;
      }

      console.log("[STT] submitting transcript:", clean);
      isSubmittingRef.current = true;
      setTranscript("");
      latestTranscriptRef.current = "";
      turnStartResultIndexRef.current = lastResultsLengthRef.current;

      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }

      interruptPlayback();
      setActionFeedback(null);

      // Reset Turn Pipeline Refs
      const turnId = ++activeTurnIdRef.current;
      turnStartTimeRef.current = performance.now();
      firstTokenTimeRef.current = null;
      firstTtsRequestTimeRef.current = null;
      firstTtsAudioReadyTimeRef.current = null;
      firstAudioPlaybackTimeRef.current = null;
      previousChunkAudioEndTimeRef.current = null;
      processedSpeechLengthRef.current = 0;
      ttsSequenceCounterRef.current = 0;
      currentPlaySequenceRef.current = 0;
      ttsQueueRef.current = [];
      audioReadyMapRef.current.clear();
      inFlightTtsCountRef.current = 0;
      isStreamCompleteRef.current = false;
      currentPlayingChunkTextRef.current = "";

      // Detect Intent
      const intentResult: IntentResult = detectIntent(clean, hasDocument);

      // Handle NAVIGATION Intent
      if (intentResult.intent === "NAVIGATION" && intentResult.navTarget) {
        setVoiceState("ACTION");
        setActionFeedback(intentResult.feedbackText || "✓ Navigating...");

        if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
        actionTimerRef.current = setTimeout(() => {
          setActionFeedback(null);
          setVoiceState("IDLE");
          isSubmittingRef.current = false;
          router.push(intentResult.navTarget!);
        }, 800);
        return;
      }

      // Handle missing document requirement
      if (intentResult.requiresDocument && !hasDocument) {
        setVoiceState("ACTION");
        setActionFeedback("⚠️ Please attach a document first");
        return;
      }

      // Execute Chat or Document Action Prompt
      setVoiceState("THINKING");
      if (intentResult.feedbackText) {
        setActionFeedback(intentResult.feedbackText);
      }

      // Ensure STT is active for interruption monitoring while THINKING
      if (!isListeningRef.current) {
        startListening();
      }

      const promptToSend = intentResult.formattedPrompt || clean;

      try {
        await sendMessageRef.current(promptToSend, null, true);
      } catch (err: any) {
        console.warn("[useVoiceConversation] Send message error:", err);
        setErrorMessage(err?.message || "Failed to send voice message");
        setVoiceState("ERROR");
        isSubmittingRef.current = false;
      }
    },
    [interruptPlayback, hasDocument, router, startListening]
  );

  // Monitor LLM streaming tokens incrementally for Streaming Voice Output
  useEffect(() => {
    if (!isVoiceActiveRef.current) return;

    if (voiceStateRef.current === "THINKING" || voiceStateRef.current === "SPEAKING") {
      const lastMessage = messages[messages.length - 1];

      if (lastMessage && lastMessage.role === "assistant") {
        const fullContent = lastMessage.content;

        if (firstTokenTimeRef.current === null && fullContent.length > 0) {
          firstTokenTimeRef.current = performance.now();
          const firstTokenMs = (firstTokenTimeRef.current - turnStartTimeRef.current).toFixed(1);
          console.log(`[VOICE STREAM] LLM chunk received (llm_first_token_ms = ${firstTokenMs}ms)`);
        }

        // Convert raw markdown into natural spoken language (stripping code blocks, markdown symbols, and LaTeX)
        const isComplete = !isLoading;
        const sanitizedSpeech = sanitizeTextForTTS(fullContent);

        // Extract small, natural sentence/clause chunks (~40-80 chars) from sanitized speech
        const extractedChunks = extractStreamingTTSChunks(
          sanitizedSpeech,
          processedSpeechLengthRef.current,
          isComplete
        );

        if (extractedChunks.length > 0) {
          for (const chunk of extractedChunks) {
            processedSpeechLengthRef.current += chunk.rawLength;
            const seq = ttsSequenceCounterRef.current++;
            ttsQueueRef.current.push({ seq, text: chunk.text });
          }
          processTtsQueue(activeTurnIdRef.current);
        }

        if (isComplete) {
          isStreamCompleteRef.current = true;
          processTtsQueue(activeTurnIdRef.current);
        }
      } else if (!isLoading && lastMessage && lastMessage.role === "error") {
        setErrorMessage(lastMessage.content);
        setVoiceState("ERROR");
        isSubmittingRef.current = false;
      }
    }
  }, [messages, isLoading, processTtsQueue]);

  const prevIsOpenRef = useRef<boolean>(isOpen);
  const prevEnableWakeWordRef = useRef<boolean>(enableWakeWord);

  // Clean up or transition between Voice Mode and Wake Word Mode
  useEffect(() => {
    isVoiceActiveRef.current = isOpen;

    const isOpenChanged = prevIsOpenRef.current !== isOpen;
    const wakeWordChanged = prevEnableWakeWordRef.current !== enableWakeWord;

    if (!isOpen) {
      if (isOpenChanged && prevIsOpenRef.current) {
        console.log("[useVoiceConversation] isOpen transitioned to false -> executing exitVoiceMode");
        exitVoiceMode();
      } else if (enableWakeWord && (wakeWordChanged || !recognitionRef.current)) {
        console.log("[useVoiceConversation] Dashboard idle mount/update -> starting Wake Word listener ('Lumina')");
        startListening();
      } else if (!enableWakeWord && wakeWordChanged) {
        console.log("[useVoiceConversation] Wake Word disabled -> stopping STT");
        stopSTT();
      }
    } else {
      if (isOpenChanged || voiceStateRef.current !== "LISTENING") {
        console.log("[useVoiceConversation] Overlay opened, starting conversation listener");
        startListening();
      }
    }
    prevIsOpenRef.current = isOpen;
    prevEnableWakeWordRef.current = enableWakeWord;
  }, [isOpen, enableWakeWord, exitVoiceMode, startListening, stopSTT]);

  // Coordinate with external microphone components (e.g. ChatInput)
  useEffect(() => {
    const handleStopSpeech = () => {
      // If idle (wake word running on Dashboard), yield microphone to other components like ChatInput
      if (!isVoiceActiveRef.current) {
        console.log("[useVoiceConversation] External speech active -> pausing wake-word STT");
        stopSTT();
      }
    };

    const handleSpeechReleased = () => {
      // When external speech releases microphone, resume wake-word if on Dashboard
      if (!isVoiceActiveRef.current && enableWakeWord && !recognitionRef.current) {
        setTimeout(() => {
          if (!isVoiceActiveRef.current && enableWakeWord && !recognitionRef.current) {
            console.log("[useVoiceConversation] External speech ended -> resuming wake-word STT");
            startListening();
          }
        }, 300);
      }
    };

    window.addEventListener("lumina:stop-speech", handleStopSpeech);
    window.addEventListener("lumina:speech-released", handleSpeechReleased);

    return () => {
      window.removeEventListener("lumina:stop-speech", handleStopSpeech);
      window.removeEventListener("lumina:speech-released", handleSpeechReleased);
    };
  }, [enableWakeWord, startListening, stopSTT]);

  // Full unmount cleanup: stop STT, abort in-flight requests, clear audio & blob URLs, clear timers
  useEffect(() => {
    return () => {
      console.log("[useVoiceConversation] Hook unmounted, performing complete cleanup");
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      if (actionTimerRef.current) {
        clearTimeout(actionTimerRef.current);
        actionTimerRef.current = null;
      }
      stopSTT();
      cleanupAudioResources();
    };
  }, [stopSTT, cleanupAudioResources]);

  // Manual Test button function
  const testTTSAudioPlayback = useCallback(async () => {
    console.log("=== MANUAL TEST TTS AUDIO PLAYBACK TRIGGERED ===");
    try {
      const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const token = Cookies.get("token");
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const testPrompt = "This is a direct test of Lumina Kokoro audio playback.";
      const res = await fetch(`${API_BASE_URL}/tts`, {
        method: "POST",
        headers,
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
      console.log("[AUDIO Test] play() resolved successfully");
    } catch (err: any) {
      console.error("[AUDIO Test] Rejection/Error:", err);
    }
  }, []);

  const toggleLoop = () => {
    setIsLoopEnabled((prev) => !prev);
  };

  // Expose diagnostic & test bridge on window for browser acceptance testing
  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__luminaVoice = {
        getState: () => ({
          voiceState: voiceStateRef.current,
          isListening: isListeningRef.current,
          isPlayingAudio: isPlayingAudioRef.current,
          inFlightTts: inFlightTtsCountRef.current,
          audioReadyDepth: audioReadyMapRef.current.size,
          activeTurnId: activeTurnIdRef.current,
          currentPlaySeq: currentPlaySequenceRef.current,
          isVoiceActive: isVoiceActiveRef.current,
        }),
        simulateSpeechInput: (speechText: string) => {
          console.log(`[TEST BRIDGE] Simulating speech input: "${speechText}"`);
          if (recognitionRef.current && recognitionRef.current.onresult) {
            recognitionRef.current.onresult({
              results: [
                Object.assign([{ transcript: speechText, confidence: 1.0 }], { isFinal: true })
              ]
            });
          }
        },
        getCurrentAudio: () => currentPlayingAudioRef.current,
        submitTranscript,
        handleImmediateInterruption,
        exitVoiceMode,
      };
    }
  }, [submitTranscript, handleImmediateInterruption, exitVoiceMode]);

  return {
    voiceState,
    transcript,
    isLoopEnabled,
    errorMessage,
    actionFeedback,
    startListening,
    stopListening: stopSTT,
    handleStop,
    exitVoiceMode,
    toggleLoop,
    testTTSAudioPlayback,
  };
}
