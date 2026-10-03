/**
 * Per-message "speak this response" playback: tries the backend Kokoro TTS first and falls back to the browser's
 * speechSynthesis. Only one message speaks at a time (module-level state), starting another stops the first.
 */
import { useState, useEffect, useRef } from "react";
import { sanitizeTextForTTS } from "@/lib/speechSanitizer";
import { isAbortError } from "@/lib/errors";

let currentAbortController: AbortController | null = null;
let activeStopCallback: (() => void) | null = null;
let currentAudioElement: HTMLAudioElement | null = null;
let currentAudioObjectURL: string | null = null;
let globalRequestId = 0;

function stopActiveSpeech() {
  globalRequestId++;

  if (currentAbortController) {
    try {
      currentAbortController.abort();
    } catch {
      // ignore
    }
    currentAbortController = null;
  }

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore errors when cancelling speech
    }
  }

  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      currentAudioElement.currentTime = 0;
    } catch {
      // ignore
    }
    currentAudioElement = null;
  }

  if (currentAudioObjectURL) {
    try {
      URL.revokeObjectURL(currentAudioObjectURL);
    } catch {
      // ignore
    }
    currentAudioObjectURL = null;
  }

  if (activeStopCallback) {
    const cb = activeStopCallback;
    activeStopCallback = null;
    cb();
  }
}

export function getPreferredFemaleVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return null;
  }

  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return null;

  const preferredFemaleNames = [
    "samantha",
    "zira",
    "jenny",
    "aria",
    "karen",
    "fiona",
    "victoria",
    "veena",
    "google us english",
    "google uk english female",
    "ava",
    "serena",
    "allison",
    "susan",
    "zoe",
    "moira",
    "stephanie",
    "eva",
    "hazel"
  ];

  // Tier 1: Preferred known natural English female voices
  const tier1Voice = voices.find((v) => {
    const isEnglish = v.lang.startsWith("en");
    const nameLower = v.name.toLowerCase();
    return isEnglish && preferredFemaleNames.some((p) => nameLower.includes(p));
  });
  if (tier1Voice) return tier1Voice;

  // Tier 2: Other English voices whose name strongly indicates a female voice
  const tier2Voice = voices.find((v) => {
    const isEnglish = v.lang.startsWith("en");
    const nameLower = v.name.toLowerCase();
    return isEnglish && (nameLower.includes("female") || nameLower.includes("woman"));
  });
  if (tier2Voice) return tier2Voice;

  // Tier 3: Browser/OS default voice if no suitable female English voice is available
  return voices.find((v) => v.default) || voices[0] || null;
}

/** Speak/stop state and toggle for one message's text. */
export function useMessageSpeech(content: string) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPendingTTS, setIsPendingTTS] = useState(false);
  const activeStopCallbackRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
      if (typeof window.speechSynthesis.onvoiceschanged !== "undefined") {
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.getVoices();
        };
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      if (activeStopCallbackRef.current && activeStopCallback === activeStopCallbackRef.current) {
        stopActiveSpeech();
      }
    };
  }, []);

  const fallbackSpeechSynthesis = (
    text: string,
    stopThisSpeech: () => void,
    clearCallback: () => void,
    requestId: number,
    controller: AbortController
  ) => {
    if (requestId !== globalRequestId || controller.signal.aborted) {
      clearCallback();
      return;
    }

    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      clearCallback();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.98;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    const voice = getPreferredFemaleVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = navigator.language || "en-US";
    }

    activeStopCallback = stopThisSpeech;

    utterance.onstart = () => {
      if (requestId !== globalRequestId || controller.signal.aborted) {
        try {
          window.speechSynthesis.cancel();
        } catch {}
        clearCallback();
        return;
      }
      setIsPendingTTS(false);
      setIsSpeaking(true);
    };

    utterance.onend = () => {
      clearCallback();
    };

    utterance.onerror = () => {
      clearCallback();
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      clearCallback();
    }
  };

  const handleToggleSpeech = async () => {
    if (isSpeaking || isPendingTTS) {
      stopActiveSpeech();
      return;
    }

    stopActiveSpeech();

    const cleanText = sanitizeTextForTTS(content);
    if (!cleanText.trim()) return;

    const requestId = ++globalRequestId;
    const controller = new AbortController();
    currentAbortController = controller;

    setIsPendingTTS(true);

    const stopThisSpeech = () => {
      setIsSpeaking(false);
      setIsPendingTTS(false);
      if (activeStopCallbackRef.current === stopThisSpeech) {
        activeStopCallbackRef.current = null;
      }
    };

    activeStopCallbackRef.current = stopThisSpeech;
    activeStopCallback = stopThisSpeech;

    const clearCallback = () => {
      setIsSpeaking(false);
      setIsPendingTTS(false);
      if (activeStopCallbackRef.current === stopThisSpeech) {
        activeStopCallbackRef.current = null;
      }
      if (activeStopCallback === stopThisSpeech) {
        activeStopCallback = null;
      }
      if (currentAbortController === controller) {
        currentAbortController = null;
      }
    };

    // 1. Try Kokoro backend TTS
    try {
      const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const headers: HeadersInit = {
        "Content-Type": "application/json",
      };

      const response = await fetch(`${API_BASE_URL}/tts`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ text: cleanText }),
        signal: controller.signal,
      });

      if (requestId !== globalRequestId || controller.signal.aborted) {
        return;
      }

      if (!response.ok) {
        throw new Error(`Kokoro TTS backend error: ${response.status}`);
      }

      const blob = await response.blob();

      if (requestId !== globalRequestId || controller.signal.aborted) {
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      currentAudioElement = audio;
      currentAudioObjectURL = objectUrl;

      audio.onplay = () => {
        if (requestId !== globalRequestId || controller.signal.aborted) {
          try {
            audio.pause();
          } catch {}
          return;
        }
        setIsPendingTTS(false);
        setIsSpeaking(true);
      };

      audio.onended = () => {
        clearCallback();
        if (currentAudioObjectURL === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          currentAudioObjectURL = null;
        }
        if (currentAudioElement === audio) {
          currentAudioElement = null;
        }
      };

      audio.onerror = () => {
        clearCallback();
        if (currentAudioObjectURL === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          currentAudioObjectURL = null;
        }
        if (currentAudioElement === audio) {
          currentAudioElement = null;
        }
        if (requestId === globalRequestId && !controller.signal.aborted) {
          fallbackSpeechSynthesis(cleanText, stopThisSpeech, clearCallback, requestId, controller);
        }
      };

      await audio.play();
      return;
    } catch (err) {
      if (isAbortError(err) || requestId !== globalRequestId || controller.signal.aborted) {
        clearCallback();
        return;
      }
      if (requestId === globalRequestId && !controller.signal.aborted) {
        fallbackSpeechSynthesis(cleanText, stopThisSpeech, clearCallback, requestId, controller);
      } else {
        clearCallback();
      }
    }
  };

  return { isSpeaking, isPendingTTS, handleToggleSpeech };
}
