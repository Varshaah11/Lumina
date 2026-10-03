/**
 * Fake Web Speech API that records every start()/abort()/stop() call, plus a navigator.mediaDevices.getUserMedia that
 * counts calls and always throws (Lumina must never use it). Call installFakeSpeechRecognition() in beforeEach.
 */
import { vi } from "vitest";

export class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  startCalls = 0;
  abortCalls = 0;
  stopCalls = 0;
  /** Where the hook created/started this recognizer (debug aid for failing tests). */
  origin = "";
  constructor() {
    this.origin = new Error().stack?.split("\n").slice(2, 9).map((l) => l.trim().replace(/\(.*[\\/](hooks|tests)[\\/]/, "(")).join(" <- ") ?? "";
    FakeRecognition.instances.push(this);
  }
  start() { this.startCalls++; }
  abort() { this.abortCalls++; }
  stop() { this.stopCalls++; }
  /** Simulates the browser granting the microphone and beginning capture. */
  fireStart() { this.onstart?.(); }
  /** Simulates the browser ending the session by itself (silence timeout, network hiccup...). */
  fireEnd() { this.onend?.(); }
  fireError(error: string) { this.onerror?.({ error }); }
  /** Simulates recognition results; each item is one result entry (interim or final), in order. */
  fireResult(items: { transcript: string; isFinal: boolean }[]) {
    const results = items.map((i) => Object.assign([{ transcript: i.transcript, confidence: 1 }], { isFinal: i.isFinal }));
    this.onresult?.({ results });
  }
  get released() { return this.abortCalls > 0 || this.stopCalls > 0; }
}

export const mediaCalls = { getUserMedia: 0 };

/** Installs the fakes for one test (globals are unstubbed after each test) and clears the recorded calls. */
export function installFakeSpeechRecognition() {
  FakeRecognition.instances.length = 0;
  mediaCalls.getUserMedia = 0;
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        mediaCalls.getUserMedia++;
        throw new Error("getUserMedia must not be called by Lumina");
      },
    },
  });
}
