/**
 * Test-only runtime shims, imported FIRST by test_mic_privacy.ts:
 *  - resolves the "@/..." path alias against the compiled output tree,
 *  - stubs "next/navigation",
 *  - provides a jsdom window plus a fake Web Speech API that records every start()/abort()/stop() call.
 */
import path from "node:path";
import Module from "node:module";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

const compiledRoot = path.resolve(__dirname, "..");
/* eslint-disable @typescript-eslint/no-explicit-any -- test shims patch Node/jsdom internals */
const anyModule = Module as any;
const originalResolve = anyModule._resolveFilename;
anyModule._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) request = path.join(compiledRoot, request.slice(2));
  if (request === "next/navigation") request = path.join(__dirname, "next_navigation_stub.js");
  return originalResolve.call(this, request, ...rest);
};

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3000/" });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
g.IS_REACT_ACT_ENVIRONMENT = true;

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
    this.origin = new Error().stack?.split("\n").slice(2, 9).map((l) => l.trim().replace(/\(.*[\\/](hooks|scripts)[\\/]/, "(")).join(" <- ") ?? "";
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
g.window.SpeechRecognition = FakeRecognition;
g.window.webkitSpeechRecognition = FakeRecognition;
(dom.window.navigator as any).mediaDevices = {
  getUserMedia: async () => {
    mediaCalls.getUserMedia++;
    throw new Error("getUserMedia must not be called by Lumina");
  },
};
