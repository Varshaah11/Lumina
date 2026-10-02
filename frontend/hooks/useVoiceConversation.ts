/**
 * Voice conversation orchestration: STT -> user speech -> chat request -> streamed assistant reply -> TTS -> playback.
 *
 * Responsibilities are split into small modules:
 *   - lib/voice/sttController.ts : the SpeechRecognition instance, session ids, transcript bookkeeping
 *   - lib/voice/ttsPipeline.ts   : chunk queue, bounded /tts prefetch, ordered playback, cancellation
 *   - lib/voice/chunker.ts       : pure speech-chunking helpers
 * This hook owns the conversation state machine (voiceState, transcript, errors), the meaning of each recognition
 * event (wake word, interruption, normal capture), intent routing and the effects that connect them to React.
 *
 * Both controllers are long-lived instances created once per hook. The session attaches itself to them as their "host"
 * after every render, so asynchronous callbacks (recognition events, fetches, audio events, timers) always run the
 * latest logic with the latest props instead of a closure from an earlier render.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Message } from "@/hooks/useChat";
import { detectIntent, IntentResult } from "@/lib/intentDetector";
import { parseWakeWord, isInterruptionCommand } from "@/lib/speechSanitizer";
import { DEBUG_ENABLED, debugLog } from "@/lib/debug";
import { getErrorMessage } from "@/lib/errors";
import { SttController, type SttHost } from "@/lib/voice/sttController";
import { TtsPipeline, type TtsPipelineHost } from "@/lib/voice/ttsPipeline";

export { isMeaningfulSpeechChunk } from "@/lib/voice/chunker";

export type VoiceState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ACTION" | "ERROR";

interface UseVoiceConversationProps {
  sendMessage: (content: string, file?: File | null, isVoice?: boolean) => Promise<void> | void;
  stopGeneration: () => void;
  isLoading: boolean;
  messages: Message[];
  isOpen: boolean;
  hasDocument?: boolean;
  /** Always-listening wake word. OFF unless the caller explicitly passes true after a user action. */
  enableWakeWord?: boolean;
  /** Called whenever the speech recognizer (microphone) actually starts or stops capturing. */
  onMicActiveChange?: (active: boolean) => void;
  onOpenVoiceMode?: () => void;
}

/** Ref that always holds the latest value; updated after each commit (never during render). */
function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function useVoiceConversation({
  sendMessage,
  stopGeneration,
  isLoading,
  messages,
  isOpen,
  hasDocument = false,
  enableWakeWord = false,
  onOpenVoiceMode,
  onMicActiveChange,
}: UseVoiceConversationProps) {
  const router = useRouter();
  const [voiceState, setVoiceState] = useState<VoiceState>("IDLE");
  const [transcript, setTranscript] = useState("");
  const [isLoopEnabled, setIsLoopEnabled] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [isMicActive, setIsMicActive] = useState(false);

  // Latest props, readable from asynchronous callbacks
  const onMicActiveChangeRef = useLatestRef(onMicActiveChange);
  const onOpenVoiceModeRef = useLatestRef(onOpenVoiceMode);
  const sendMessageRef = useLatestRef(sendMessage);
  const stopGenerationRef = useLatestRef(stopGeneration);
  const hasDocumentRef = useLatestRef(hasDocument);
  const enableWakeWordRef = useLatestRef(enableWakeWord);

  // Session state mirrored in refs for asynchronous callbacks
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWakeTriggerTimeRef = useRef<number>(0);
  const isLoopEnabledRef = useRef<boolean>(isLoopEnabled);
  const isSubmittingRef = useRef<boolean>(false);
  const isVoiceActiveRef = useRef<boolean>(isOpen);
  const voiceStateRef = useRef<VoiceState>("IDLE");

  // Latest implementations of the session logic, assigned after every render (see "Host wiring" below)
  const startListeningRef = useRef<() => void>(() => {});
  const submitTranscriptRef = useRef<(text: string) => Promise<void>>(async () => {});

  // The two controllers: created once, connected to this session in the "Host wiring" effect
  const [stt] = useState(() => new SttController());
  const [tts] = useState(() => new TtsPipeline());

  const logStateTransition = useCallback((actionName: string) => {
    debugLog(
      `[STATE TRANSITION - ${actionName}] voiceState=${voiceStateRef.current}, ` +
      `isListening=${stt.isListening}, isPlayingAudio=${tts.isPlaying}, ` +
      `isVoiceActive=${isVoiceActiveRef.current}, recognition=${stt.hasRecognition}`
    );
  }, [stt, tts]);

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

  // Stop playback and discard the current turn (user interruption or a new utterance)
  const interruptPlayback = useCallback(() => {
    tts.interrupt();
  }, [tts]);

  // Stop the microphone
  const stopListening = useCallback(() => {
    stt.stop();
  }, [stt]);

  // Start STT Microphone Listener (single-instance). Only called for an explicit user action or an opted-in mode.
  const startListening = useCallback((): void => {
    if (typeof window === "undefined") return;

    // Guard against rapid duplicate clicks while recognition is initializing
    if (stt.isStarting) {
      debugLog("[startListening] Recognition is currently initializing, ignoring duplicate trigger.");
      return;
    }

    // If user clicks while assistant is actively speaking or generating, immediately interrupt and transition to listening
    if (tts.isPlaying || voiceStateRef.current === "SPEAKING" || voiceStateRef.current === "THINKING") {
      debugLog("[startListening] Interrupting active playback/generation to start listening");
      interruptPlayback();
      stopGenerationRef.current();
      isSubmittingRef.current = false;
      setTranscript("");
      stt.resetTurn();
      setActionFeedback(null);
    }

    if (stt.isListening && stt.hasRecognition) {
      if (isVoiceActiveRef.current && voiceStateRef.current === "LISTENING") {
        debugLog("[startListening] Recognition is already active and in LISTENING state.");
        return;
      }
      debugLog("[startListening] Transitioning active recognition into LISTENING state");
      stt.stop();
      if (isVoiceActiveRef.current) {
        setVoiceState("LISTENING");
        voiceStateRef.current = "LISTENING";
        setTranscript("");
      }
      setTimeout(() => {
        startListeningRef.current();
      }, 100);
      return;
    }

    setErrorMessage(null);
    stt.begin();
  }, [stt, tts, interruptPlayback, stopGenerationRef]);

  // Immediate Interruption Handler (for "stop", "Lumina stop", "stop Lumina")
  const handleImmediateInterruption = useCallback(
    (triggerPhrase: string): void => {
      debugLog(`[INTERRUPTION] "${triggerPhrase}" detected -> IMMEDIATELY halting playback and LLM stream`);
      // Invalidate active turn so in-flight TTS responses are discarded
      tts.invalidateTurn();

      // Abort in-flight TTS fetches and clean up audio objects
      tts.cleanup();

      // Abort LLM stream
      stopGenerationRef.current();

      isSubmittingRef.current = false;
      setTranscript("");
      stt.resetTurn();
      setActionFeedback(null);

      // Clean restart into fresh LISTENING session
      stt.stop();
      setVoiceState("LISTENING");
      voiceStateRef.current = "LISTENING";
      setTimeout(() => {
        if (isVoiceActiveRef.current) {
          startListeningRef.current();
        }
      }, 100);
    },
    [stt, tts, stopGenerationRef]
  );

  // Full stop / abort handler
  const handleStop = useCallback(() => {
    debugLog("[handleStop] User triggered full stop");
    tts.invalidateTurn();
    stt.resetTurn();
    stt.stop();
    interruptPlayback();
    stopGenerationRef.current();
    isSubmittingRef.current = false;
    setTranscript("");
    setActionFeedback(null);
    setVoiceState("IDLE");
  }, [stt, tts, interruptPlayback, stopGenerationRef]);

  // Immediate Voice Mode Exit Handler (Immediate, race-free termination)
  const exitVoiceMode = useCallback(() => {
    debugLog("[exitVoiceMode] Immediately stopping ALL voice activity and invalidating session");

    // 1. Mark voice inactive FIRST to prevent any pending async actions or callbacks
    isVoiceActiveRef.current = false;

    // 2. Invalidate active session and active turn immediately
    stt.invalidateSession();
    tts.invalidateTurn();

    // 3. Stop STT recognition immediately (removes handlers and aborts)
    stt.stop();

    // 4. Clean up all audio resources (pauses current audio, nullifies ref, revokes blob URLs, clears audio queues, aborts in-flight /tts fetches)
    tts.cleanup();
    tts.cancelSpeechSynthesis();

    // 5. Abort active LLM generation stream
    stopGenerationRef.current();

    // 6. Clear any pending silence or action timers
    stt.clearSilenceTimer();
    if (actionTimerRef.current) {
      clearTimeout(actionTimerRef.current);
      actionTimerRef.current = null;
    }

    // 7. Reset submission state, transcript, and UI feedback
    isSubmittingRef.current = false;
    setTranscript("");
    stt.resetTurn();
    setActionFeedback(null);
    setVoiceState("IDLE");

    // 8. If wake word is enabled on Dashboard, restart wake-word listener after cleanup
    if (enableWakeWord) {
      debugLog("[exitVoiceMode] Scheduling clean restart of Wake Word listener ('Lumina')");
      const currentSessionId = stt.sessionId;
      setTimeout(() => {
        if (!isVoiceActiveRef.current && stt.sessionId === currentSessionId && enableWakeWord) {
          startListeningRef.current();
        }
      }, 200);
    }
  }, [stt, tts, enableWakeWord, stopGenerationRef]);

  // Submit speech transcript through Intent & Action Router
  const submitTranscript = useCallback(
    async (textToSubmit: string) => {
      const clean = textToSubmit.trim();
      if (!clean || clean.length < 2 || isSubmittingRef.current) {
        return;
      }

      debugLog("[STT] submitting transcript:", clean);
      isSubmittingRef.current = true;
      setTranscript("");
      stt.beginNextTurn();
      stt.clearSilenceTimer();

      interruptPlayback();
      setActionFeedback(null);

      // Reset the TTS pipeline for the new turn
      tts.startTurn();

      // Detect Intent (uses the CURRENT hasDocument, not the value from when the recognizer was created)
      const currentHasDocument = hasDocumentRef.current;
      const intentResult: IntentResult = detectIntent(clean, currentHasDocument);

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
      if (intentResult.requiresDocument && !currentHasDocument) {
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
      if (!stt.isListening) {
        startListeningRef.current();
      }

      const promptToSend = intentResult.formattedPrompt || clean;

      try {
        await sendMessageRef.current(promptToSend, null, true);
      } catch (err) {
        console.warn("[useVoiceConversation] Send message error:", err);
        setErrorMessage(getErrorMessage(err, "Failed to send voice message"));
        setVoiceState("ERROR");
        isSubmittingRef.current = false;
      }
    },
    [stt, tts, interruptPlayback, router, hasDocumentRef, sendMessageRef]
  );

  // ---------------------------------------------------------------------------------------------------------------
  // Host wiring: what recognition events and playback events mean for the conversation. Re-assigned after every render
  // (before any effect below that can start the microphone, because effects run in declaration order).
  // ---------------------------------------------------------------------------------------------------------------
  useEffect(() => {
    startListeningRef.current = startListening;
    submitTranscriptRef.current = submitTranscript;

    const sttHost: SttHost = {
      onMicActiveChange: (active) => setIsMicActive(active),

      onStarted: () => {
        if (isVoiceActiveRef.current) {
          if (!tts.isPlaying && voiceStateRef.current !== "THINKING" && voiceStateRef.current !== "SPEAKING") {
            setVoiceState("LISTENING");
            voiceStateRef.current = "LISTENING";
          }
        }
      },

      onTranscript: (fullText, sessionId) => {
        // SCENARIO 1: Dashboard Idle Wake-Word Mode (isOpen is false)
        if (!isVoiceActiveRef.current) {
          if (enableWakeWordRef.current && fullText.length >= 2) {
            const { isWake, prompt } = parseWakeWord(fullText);
            if (isWake) {
              const now = Date.now();
              if (now - lastWakeTriggerTimeRef.current < 2000) {
                return; // Debounce repeated triggers
              }
              lastWakeTriggerTimeRef.current = now;
              debugLog(`[WAKE WORD DETECTED] "Lumina" heard! Trailing prompt="${prompt}"`);

              onOpenVoiceModeRef.current?.();

              if (prompt.length >= 2) {
                debugLog(`[WAKE WORD] Immediate question found: "${prompt}" -> auto-submitting`);
                setTimeout(() => {
                  void submitTranscriptRef.current(prompt);
                }, 100);
              } else {
                debugLog(`[WAKE WORD] Wake word only -> ready for user question`);
                setVoiceState("LISTENING");
                voiceStateRef.current = "LISTENING";
              }
            }
          }
          return;
        }

        // SCENARIO 2: In Voice Mode while Assistant is SPEAKING or THINKING (Interruption Monitoring)
        if (voiceStateRef.current === "SPEAKING" || voiceStateRef.current === "THINKING" || tts.isPlaying) {
          if (isInterruptionCommand(fullText, tts.currentChunkText)) {
            handleImmediateInterruption(fullText);
          }
          return;
        }

        // SCENARIO 3: In Voice Mode while LISTENING (Normal Speech Capture)
        if (voiceStateRef.current === "LISTENING" && !isSubmittingRef.current) {
          if (fullText.length >= 1) {
            setTranscript(fullText);
            stt.clearSilenceTimer();

            if (fullText.length >= 2) {
              stt.armSilenceTimer(1500, () => {
                if (
                  stt.sessionId === sessionId &&
                  isVoiceActiveRef.current &&
                  voiceStateRef.current === "LISTENING" &&
                  !isSubmittingRef.current
                ) {
                  debugLog("[STT] silence detected, auto-submitting transcript:", stt.latestTranscript);
                  void submitTranscriptRef.current(stt.latestTranscript);
                }
              });
            }
          }
        }
      },

      onError: (error) => {
        if (error === "not-allowed" || error === "service-not-allowed") {
          setErrorMessage("Microphone access was blocked. Please allow microphone permissions in your browser URL bar.");
          if (isVoiceActiveRef.current) {
            setVoiceState("ERROR");
          }
          stt.stop();
        } else if (error === "audio-capture") {
          setErrorMessage("No microphone detected. Please plug in or select a microphone and try again.");
          if (isVoiceActiveRef.current) {
            setVoiceState("ERROR");
          }
          stt.stop();
        } else if (error === "network") {
          setErrorMessage("Voice recognition network error. Please check your internet connection.");
          if (isVoiceActiveRef.current) {
            setVoiceState("ERROR");
          }
        } else if (error !== "aborted") {
          if (isVoiceActiveRef.current) {
            setErrorMessage(`Voice recognition encountered an issue (${error}). Tap to retry.`);
            setVoiceState("ERROR");
          }
        }
      },

      onEnded: (sessionId) => {
        // Auto-restart recognition based on active state
        if (isVoiceActiveRef.current) {
          if (voiceStateRef.current === "LISTENING") {
            if (stt.latestTranscript.trim().length >= 2 && !isSubmittingRef.current) {
              void submitTranscriptRef.current(stt.latestTranscript);
            } else if (!isSubmittingRef.current && isLoopEnabledRef.current) {
              setTimeout(() => {
                if (
                  stt.sessionId === sessionId &&
                  isVoiceActiveRef.current &&
                  (voiceStateRef.current === "LISTENING" || voiceStateRef.current === "IDLE")
                ) {
                  startListeningRef.current();
                }
              }, 200);
            } else {
              setVoiceState("IDLE");
            }
          } else if (voiceStateRef.current === "THINKING" || voiceStateRef.current === "SPEAKING") {
            // Keep listening for interruptions during speech/synthesis
            setTimeout(() => {
              if (
                stt.sessionId === sessionId &&
                isVoiceActiveRef.current &&
                (voiceStateRef.current === "THINKING" || voiceStateRef.current === "SPEAKING")
              ) {
                startListeningRef.current();
              }
            }, 200);
          }
        } else if (enableWakeWordRef.current) {
          // Keep listening for wake word on Dashboard
          setTimeout(() => {
            if (stt.sessionId === sessionId && !isVoiceActiveRef.current && enableWakeWordRef.current) {
              startListeningRef.current();
            }
          }, 300);
        }
      },

      onUnsupported: () => {
        setErrorMessage("Voice input is not supported in this browser.");
        setVoiceState("ERROR");
      },

      onStartFailed: () => {
        if (isVoiceActiveRef.current) {
          setErrorMessage("Failed to activate microphone. Tap to retry.");
          setVoiceState("ERROR");
        }
      },
    };

    const ttsHost: TtsPipelineHost = {
      isVoiceActive: () => isVoiceActiveRef.current,

      onChunkPlaybackStart: () => {
        setVoiceState("SPEAKING");

        // Ensure STT is active for interruption detection
        if (!stt.isListening) {
          startListeningRef.current();
        }
      },

      onAllChunksPlayed: () => {
        setActionFeedback(null);
        isSubmittingRef.current = false;

        if (isVoiceActiveRef.current && isLoopEnabledRef.current) {
          debugLog("[VOICE STREAM] All audio chunks completed naturally -> restarting clean listening turn");
          setVoiceState("LISTENING");
          voiceStateRef.current = "LISTENING";
          setTranscript("");
          stt.resetTurn();
          stt.stop();
          setTimeout(() => {
            if (isVoiceActiveRef.current) {
              startListeningRef.current();
            }
          }, 100);
        } else {
          setVoiceState("IDLE");
        }
      },
    };

    stt.attachHost(sttHost);
    tts.attachHost(ttsHost);
  });

  // Monitor LLM streaming tokens incrementally for Streaming Voice Output
  useEffect(() => {
    if (!isVoiceActiveRef.current) return;

    if (voiceStateRef.current === "THINKING" || voiceStateRef.current === "SPEAKING") {
      const lastMessage = messages[messages.length - 1];

      if (lastMessage && lastMessage.role === "assistant") {
        tts.feedAssistantText(lastMessage.content, !isLoading);
      } else if (!isLoading && lastMessage && lastMessage.role === "error") {
        setErrorMessage(lastMessage.content);
        setVoiceState("ERROR");
        isSubmittingRef.current = false;
      }
    }
  }, [messages, isLoading, tts]);

  const prevIsOpenRef = useRef<boolean>(isOpen);
  const prevEnableWakeWordRef = useRef<boolean>(enableWakeWord);

  // Report real microphone state (capturing or not) to the UI
  useEffect(() => {
    onMicActiveChangeRef.current?.(isMicActive);
  }, [isMicActive, onMicActiveChangeRef]);

  // Clean up or transition between Voice Mode and Wake Word Mode.
  // isLoopEnabled is listed on purpose: this effect has always re-run when the loop flag changed (it used to depend on
  // startListening, whose identity changed with the flag), and that behavior is preserved exactly.
  useEffect(() => {
    isVoiceActiveRef.current = isOpen;

    const isOpenChanged = prevIsOpenRef.current !== isOpen;
    const wakeWordChanged = prevEnableWakeWordRef.current !== enableWakeWord;

    if (!isOpen) {
      if (isOpenChanged && prevIsOpenRef.current) {
        debugLog("[useVoiceConversation] isOpen transitioned to false -> executing exitVoiceMode");
        exitVoiceMode();
      } else if (enableWakeWord && (wakeWordChanged || !stt.hasRecognition)) {
        debugLog("[useVoiceConversation] Dashboard idle mount/update -> starting Wake Word listener ('Lumina')");
        startListening();
      } else if (!enableWakeWord && wakeWordChanged) {
        debugLog("[useVoiceConversation] Wake Word disabled -> stopping STT");
        stt.stop();
      }
    } else {
      if (isOpenChanged || voiceStateRef.current !== "LISTENING") {
        debugLog("[useVoiceConversation] Overlay opened, starting conversation listener");
        startListening();
      }
    }
    prevIsOpenRef.current = isOpen;
    prevEnableWakeWordRef.current = enableWakeWord;
  }, [isOpen, enableWakeWord, isLoopEnabled, exitVoiceMode, startListening, stt]);

  // Coordinate with external microphone components (e.g. ChatInput)
  useEffect(() => {
    const handleStopSpeech = () => {
      // If idle (wake word running on Dashboard), yield microphone to other components like ChatInput
      if (!isVoiceActiveRef.current) {
        debugLog("[useVoiceConversation] External speech active -> pausing wake-word STT");
        stt.stop();
      }
    };

    const handleSpeechReleased = () => {
      // When external speech releases microphone, resume wake-word if on Dashboard
      if (!isVoiceActiveRef.current && enableWakeWord && !stt.hasRecognition) {
        setTimeout(() => {
          if (!isVoiceActiveRef.current && enableWakeWord && !stt.hasRecognition) {
            debugLog("[useVoiceConversation] External speech ended -> resuming wake-word STT");
            startListeningRef.current();
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
  }, [enableWakeWord, stt]);

  // Full unmount cleanup: stop STT, abort in-flight requests, clear audio & blob URLs, clear timers
  useEffect(() => {
    return () => {
      debugLog("[useVoiceConversation] Hook unmounted, performing complete cleanup");
      stt.clearSilenceTimer();
      if (actionTimerRef.current) {
        clearTimeout(actionTimerRef.current);
        actionTimerRef.current = null;
      }
      stt.stop();
      tts.cleanup();
    };
  }, [stt, tts]);

  // Manual Test button function
  const testTTSAudioPlayback = useCallback(() => tts.playTestSound(), [tts]);

  const toggleLoop = () => {
    setIsLoopEnabled((prev) => !prev);
  };

  // Expose diagnostic & test bridge on window for browser acceptance testing (development only: it can inject
  // speech and drive the voice session, so it is never exposed in production builds)
  useEffect(() => {
    if (typeof window !== "undefined" && DEBUG_ENABLED) {
      Object.assign(window, { __luminaVoice: {
        getState: () => ({
          voiceState: voiceStateRef.current,
          isListening: stt.isListening,
          isPlayingAudio: tts.isPlaying,
          inFlightTts: tts.inFlight,
          audioReadyDepth: tts.audioReadyDepth,
          activeTurnId: tts.activeTurnId,
          currentPlaySeq: tts.currentPlaySeq,
          isVoiceActive: isVoiceActiveRef.current,
        }),
        simulateSpeechInput: (speechText: string) => {
          debugLog(`[TEST BRIDGE] Simulating speech input: "${speechText}"`);
          stt.simulateResult(speechText);
        },
        getCurrentAudio: () => tts.playingAudio,
        submitTranscript,
        handleImmediateInterruption,
        exitVoiceMode,
      } });
    }
  }, [stt, tts, submitTranscript, handleImmediateInterruption, exitVoiceMode]);

  return {
    voiceState,
    transcript,
    isLoopEnabled,
    errorMessage,
    actionFeedback,
    isMicActive,
    startListening,
    stopListening,
    handleStop,
    exitVoiceMode,
    toggleLoop,
    testTTSAudioPlayback,
  };
}
