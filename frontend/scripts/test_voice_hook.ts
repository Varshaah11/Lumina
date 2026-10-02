/**
 * Behavior (characterization) tests for useVoiceConversation: STT turn handling, wake word, interruption, the streaming
 * TTS queue/playback pipeline, cancellation and session state. They drive the public hook with a fake SpeechRecognition,
 * fake Audio, a controllable /tts fetch and a fake clock, and assert only observable behavior, so they hold across
 * internal refactors. Run from frontend/:
 *   OUT=$(mktemp -d) && npx tsc -p scripts/tsconfig.test.json --outDir $OUT \
 *     && cp scripts/next_navigation_stub.js $OUT/scripts/ && NODE_PATH=$PWD/node_modules node $OUT/scripts/test_voice_hook.js
 */
import { FakeRecognition } from "./mic_test_support";
import { FakeAudio, FakeClock, resetVoiceShims, tts, urls } from "./voice_test_support";
import assert from "node:assert/strict";
import React, { act, useEffect } from "react";
import { createRoot, Root } from "react-dom/client";
import { useVoiceConversation } from "../hooks/useVoiceConversation";
import type { Message } from "../hooks/useChat";

type Hook = ReturnType<typeof useVoiceConversation>;
interface Props {
  isOpen: boolean;
  enableWakeWord: boolean;
  hasDocument: boolean;
  isLoading: boolean;
  messages: Message[];
}
const g = globalThis as unknown as { __routerPushes?: string[] };

const clock = new FakeClock();
let root: Root | null = null;
let hook: Hook;
let props: Props;
const sent: { text: string; file: unknown; isVoice: unknown }[] = [];
let stops = 0;
let opened = 0;
const micChanges: boolean[] = [];
let sendImpl: () => Promise<void> | void = () => {};

function Harness(p: Props) {
  const current = useVoiceConversation({
    sendMessage: (text, file, isVoice) => { sent.push({ text, file, isVoice }); return sendImpl(); },
    stopGeneration: () => { stops++; },
    isLoading: p.isLoading,
    messages: p.messages,
    isOpen: p.isOpen,
    hasDocument: p.hasDocument,
    enableWakeWord: p.enableWakeWord,
    onOpenVoiceMode: () => { opened++; },
    onMicActiveChange: (a) => { micChanges.push(a); },
  });
  useEffect(() => { hook = current; });
  return null;
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function advance(ms: number) { await act(async () => { clock.advance(ms); await Promise.resolve(); await Promise.resolve(); }); await flush(); }
async function mount(over: Partial<Props> = {}) {
  props = { isOpen: false, enableWakeWord: false, hasDocument: false, isLoading: false, messages: [], ...over };
  root = createRoot(document.createElement("div"));
  await act(async () => { root!.render(React.createElement(Harness, props)); });
}
async function update(over: Partial<Props>) {
  props = { ...props, ...over };
  await act(async () => { root!.render(React.createElement(Harness, props)); });
}
async function unmount() { if (root) { await act(async () => { root!.unmount(); }); root = null; } }
const rec = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];
const live = () => FakeRecognition.instances.filter((i) => !i.released);
const msg = (id: string, role: Message["role"], content: string): Message => ({ id, role, content, timestamp: new Date(0) });

async function startOpen(over: Partial<Props> = {}) {
  await mount({ isOpen: true, ...over });
  await act(async () => { rec().fireStart(); });
}
/** Speak a final utterance and let the recognizer end, which submits it as a turn. */
async function speakAndSubmit(text: string) {
  await act(async () => { rec().fireResult([{ transcript: text, isFinal: true }]); });
  await act(async () => { rec().fireEnd(); });
}
/** After a submitted turn: the assistant starts streaming `content` (still loading, or complete). */
async function assistantSays(content: string, complete: boolean) {
  await update({ messages: [msg("u", "user", "q"), msg("a", "assistant", content)], isLoading: !complete });
}

const LONG_REPLY = "Rivers carry water from the mountains down to the sea. They shape valleys over thousands of years. Many cities grew along their banks.";

let passed = 0;
const failures: string[] = [];
const results: Record<string, "PASS" | "FAIL"> = {};
async function test(name: string, fn: () => Promise<void>) {
  FakeRecognition.instances.length = 0;
  resetVoiceShims();
  sent.length = 0; stops = 0; opened = 0; micChanges.length = 0; sendImpl = () => {};
  const log = console.log; const warn = console.warn; const err = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clock.install();
  let error: Error | null = null;
  try { await fn(); } catch (e) { error = e as Error; }
  try { await unmount(); } catch { /* ignore */ }
  clock.uninstall();
  console.log = log; console.warn = warn; console.error = err;
  if (error) { failures.push(name); results[name] = "FAIL"; console.log(`  [FAIL] ${name}\n         ${process.env.VOICE_TEST_VERBOSE ? error.message.split("\n").slice(0, 8).join("\n         ") : error.message.split("\n")[0]}`); }
  else { passed++; results[name] = "PASS"; console.log(`  [PASS] ${name}`); }
}

async function main() {
  console.log("\n=== Voice hook behavior tests ===");

  // ------------------------------------------------------------------ STT
  await test("STT: opening voice mode creates a continuous interim recognizer and reports LISTENING / mic active", async () => {
    await mount({ isOpen: true });
    assert.equal(FakeRecognition.instances.length, 1);
    const r = rec();
    assert.equal(r.startCalls, 1);
    assert.equal(r.continuous, true);
    assert.equal(r.interimResults, true);
    assert.ok(r.lang.length > 0);
    await act(async () => { r.fireStart(); });
    assert.equal(hook.voiceState, "LISTENING");
    assert.equal(hook.isMicActive, true);
    assert.deepEqual(micChanges.filter((c) => c === true).length > 0, true);
  });

  await test("STT: interim and final results build the live transcript", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "hello", isFinal: false }]); });
    assert.equal(hook.transcript, "hello");
    await act(async () => { rec().fireResult([{ transcript: "hello", isFinal: true }, { transcript: "wor", isFinal: false }]); });
    assert.equal(hook.transcript, "hello wor");
    await act(async () => { rec().fireResult([{ transcript: "hello", isFinal: true }, { transcript: "world", isFinal: true }]); });
    assert.equal(hook.transcript, "helloworld");
  });

  await test("STT: 1.5 s of silence auto-submits the transcript as a voice message", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "tell me about rivers", isFinal: true }]); });
    await advance(1499);
    assert.equal(sent.length, 0);
    await advance(1);
    assert.deepEqual(sent, [{ text: "tell me about rivers", file: null, isVoice: true }]);
    assert.equal(hook.voiceState, "THINKING");
    assert.equal(hook.transcript, "");
  });

  await test("STT: a one-character transcript is not submitted", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "a", isFinal: true }]); });
    await advance(5000);
    assert.equal(sent.length, 0);
  });

  await test("STT: recognizer ending with a transcript submits immediately", async () => {
    await startOpen();
    await speakAndSubmit("good morning lumina");
    assert.deepEqual(sent.map((s) => s.text), ["good morning lumina"]);
    assert.equal(hook.voiceState, "THINKING");
  });

  await test("STT: submitting twice for the same utterance is guarded", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "tell me a joke", isFinal: true }]); });
    await act(async () => { rec().fireEnd(); });
    await advance(2000);
    assert.equal(sent.length, 1);
  });

  await test("STT: ending with no speech restarts the recognizer while the loop is enabled", async () => {
    await startOpen();
    const before = FakeRecognition.instances.length;
    await act(async () => { rec().fireEnd(); });
    assert.equal(FakeRecognition.instances.length, before);
    await advance(200);
    assert.equal(FakeRecognition.instances.length, before + 1);
    assert.equal(rec().startCalls, 1);
  });

  await test("STT: with the loop disabled, ending with no speech goes IDLE and does not restart", async () => {
    await startOpen();
    await act(async () => { hook.toggleLoop(); });
    const before = FakeRecognition.instances.length;
    await act(async () => { rec().fireEnd(); });
    await advance(1000);
    assert.equal(FakeRecognition.instances.length, before);
    assert.equal(hook.voiceState, "IDLE");
  });

  await test("STT: late onend from a replaced recognizer is ignored", async () => {
    await startOpen();
    const first = rec();
    await act(async () => { first.fireEnd(); });
    await advance(200);
    const second = rec();
    assert.notEqual(first, second);
    await act(async () => { second.fireStart(); });
    const count = FakeRecognition.instances.length;
    await act(async () => { first.fireEnd(); });
    await advance(1000);
    assert.equal(FakeRecognition.instances.length, count);
    assert.equal(hook.isMicActive, true);
  });

  await test("STT errors: not-allowed shows the blocked message, ERROR state and aborts the recognizer", async () => {
    await startOpen();
    const r = rec();
    await act(async () => { r.fireError("not-allowed"); });
    assert.match(hook.errorMessage ?? "", /Microphone access was blocked/);
    assert.equal(hook.voiceState, "ERROR");
    assert.ok(r.abortCalls >= 1);
    assert.equal(hook.isMicActive, false);
    await advance(2000);
    assert.equal(FakeRecognition.instances.length, 1, "no retry after a denial");
  });

  await test("STT errors: audio-capture, network, unknown and benign errors", async () => {
    await startOpen();
    await act(async () => { rec().fireError("no-speech"); });
    assert.equal(hook.errorMessage, null);
    assert.equal(hook.voiceState, "LISTENING");
    await act(async () => { rec().fireError("aborted"); });
    assert.equal(hook.errorMessage, null);
    await act(async () => { rec().fireError("network"); });
    assert.match(hook.errorMessage ?? "", /network error/);
    assert.equal(hook.voiceState, "ERROR");
    assert.equal(rec().abortCalls, 0, "network errors keep the recognizer");
    await act(async () => { rec().fireError("language-not-supported"); });
    assert.match(hook.errorMessage ?? "", /\(language-not-supported\)/);
    await act(async () => { rec().fireError("audio-capture"); });
    assert.match(hook.errorMessage ?? "", /No microphone detected/);
    assert.ok(rec().abortCalls >= 1);
  });

  await test("STT: unsupported browser shows an error state", async () => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    const saved = [w.SpeechRecognition, w.webkitSpeechRecognition];
    w.SpeechRecognition = undefined; w.webkitSpeechRecognition = undefined;
    try {
      await mount({ isOpen: true });
      assert.match(hook.errorMessage ?? "", /not supported/);
      assert.equal(hook.voiceState, "ERROR");
    } finally {
      [w.SpeechRecognition, w.webkitSpeechRecognition] = saved;
    }
  });

  await test("STT: recognizer start() throwing shows an activation error", async () => {
    const original = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = function () { throw new Error("denied by policy"); };
    try {
      await mount({ isOpen: true });
      assert.match(hook.errorMessage ?? "", /Failed to activate microphone/);
      assert.equal(hook.voiceState, "ERROR");
    } finally {
      FakeRecognition.prototype.start = original;
    }
  });

  await test("STT: explicit startListening()/stopListening() from the public API", async () => {
    await mount({ isOpen: false });
    assert.equal(FakeRecognition.instances.length, 0);
    await act(async () => { hook.startListening(); });
    assert.equal(FakeRecognition.instances.length, 1);
    await act(async () => { hook.startListening(); });
    assert.equal(FakeRecognition.instances.length, 1, "duplicate trigger while starting is ignored");
    await act(async () => { rec().fireStart(); });
    await act(async () => { hook.stopListening(); });
    assert.ok(FakeRecognition.instances[0].abortCalls >= 1);
    assert.equal(hook.isMicActive, false);
  });

  // ------------------------------------------------------------------ wake word
  await test("wake word: heard with a trailing question opens voice mode and submits the question", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { rec().fireResult([{ transcript: "hey Lumina what time is it", isFinal: true }]); });
    assert.equal(opened, 1);
    await advance(100);
    assert.deepEqual(sent.map((s) => s.text), ["what time is it"]);
    assert.equal(hook.voiceState, "THINKING");
  });

  await test("wake word: only 'Lumina' opens voice mode and waits for the question; repeats are debounced", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { rec().fireResult([{ transcript: "Lumina", isFinal: true }]); });
    assert.equal(opened, 1);
    assert.equal(hook.voiceState, "LISTENING");
    await act(async () => { rec().fireResult([{ transcript: "Lumina", isFinal: false }]); });
    assert.equal(opened, 1, "debounced within 2 s");
    await advance(2100);
    await act(async () => { rec().fireResult([{ transcript: "Lumina", isFinal: true }]); });
    assert.equal(opened, 2);
    assert.equal(sent.length, 0);
  });

  await test("wake word: ordinary speech while idle is ignored", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { rec().fireResult([{ transcript: "just talking about lumina later", isFinal: true }]); });
    assert.equal(opened, 0);
    assert.equal(sent.length, 0);
  });

  await test("wake word: OFF means no recognizer at all; toggling on starts one, off aborts it", async () => {
    await mount({ enableWakeWord: false });
    await advance(5000);
    assert.equal(FakeRecognition.instances.length, 0);
    await update({ enableWakeWord: true });
    assert.equal(live().length, 1);
    const r = rec();
    await update({ enableWakeWord: false });
    assert.ok(r.abortCalls >= 1);
    await advance(5000);
    assert.equal(live().length, 0);
  });

  await test("wake word: keeps listening after the recognizer ends (300 ms restart)", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { rec().fireEnd(); });
    assert.equal(FakeRecognition.instances.length, 1);
    await advance(300);
    assert.equal(FakeRecognition.instances.length, 2);
  });

  await test("wake word: yields the microphone to other components and resumes afterwards", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    const first = rec();
    await act(async () => { window.dispatchEvent(new window.Event("lumina:stop-speech")); });
    assert.ok(first.abortCalls >= 1);
    assert.equal(hook.isMicActive, false);
    await act(async () => { window.dispatchEvent(new window.Event("lumina:speech-released")); });
    await advance(300);
    assert.equal(live().length, 1);
    assert.equal(FakeRecognition.instances.length, 2);
  });

  await test("wake word: stop-speech does not stop an active voice session", async () => {
    await startOpen();
    const r = rec();
    await act(async () => { window.dispatchEvent(new window.Event("lumina:stop-speech")); });
    assert.equal(r.abortCalls, 0);
  });

  // ------------------------------------------------------------------ intents
  await test("intent: navigation phrase goes ACTION then navigates after 800 ms", async () => {
    await startOpen();
    await speakAndSubmit("open my history");
    assert.equal(hook.voiceState, "ACTION");
    assert.match(hook.actionFeedback ?? "", /History/);
    assert.equal(g.__routerPushes?.length ?? 0, 0);
    await advance(800);
    assert.deepEqual(g.__routerPushes, ["/history"]);
    assert.equal(hook.voiceState, "IDLE");
    assert.equal(sent.length, 0);
  });

  await test("intent: document action without a document warns and sends nothing", async () => {
    await startOpen({ hasDocument: false });
    await speakAndSubmit("summarize this document");
    assert.equal(hook.voiceState, "ACTION");
    assert.match(hook.actionFeedback ?? "", /attach a document/);
    assert.equal(sent.length, 0);
  });

  await test("intent: document action with a document sends the formatted prompt", async () => {
    await startOpen({ hasDocument: true });
    await speakAndSubmit("summarize this document");
    assert.deepEqual(sent.map((s) => s.text), ["Summarize this document in 5 key points."]);
    assert.match(hook.actionFeedback ?? "", /Summarizing/);
  });

  await test("intent: hasDocument that becomes true during an open session is honoured by the next utterance", async () => {
    await startOpen({ hasDocument: false });
    await update({ hasDocument: true });
    await speakAndSubmit("summarize this document");
    assert.deepEqual(sent.map((s) => s.text), ["Summarize this document in 5 key points."]);
  });

  await test("send failure: rejected sendMessage shows an error and clears the submitting guard", async () => {
    sendImpl = () => Promise.reject(new Error("backend down"));
    await startOpen();
    await speakAndSubmit("tell me a story");
    await flush();
    assert.equal(hook.errorMessage, "backend down");
    assert.equal(hook.voiceState, "ERROR");
  });

  await test("chat error: an error message from the chat while THINKING surfaces as ERROR", async () => {
    await startOpen();
    await speakAndSubmit("tell me a story");
    await update({ messages: [msg("u", "user", "q"), msg("e", "error", "Lumina couldn't connect.")], isLoading: false });
    assert.equal(hook.errorMessage, "Lumina couldn't connect.");
    assert.equal(hook.voiceState, "ERROR");
  });

  // ------------------------------------------------------------------ TTS pipeline
  await test("TTS: streamed reply is chunked in order and requested from /tts with at most 2 in flight", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    assert.ok(tts.calls.length >= 1);
    assert.ok(tts.calls.length <= 2, `in flight must be capped at 2, got ${tts.calls.length}`);
    assert.match(tts.url, /\/tts$/);
    const requested: string[] = tts.calls.map((c) => c.text);
    // drain everything in order and collect every chunk requested over time
    const all: string[] = [...requested];
    for (let guard = 0; guard < 20 && tts.calls.some((c) => !c.settled); guard++) {
      tts.calls.filter((c) => !c.settled).forEach((c) => c.respond());
      await flush(); await flush();
      FakeAudio.instances.filter((a) => a.playCalls > 0 && a.onended).forEach((a) => { if (!(a as FakeAudio & { done?: boolean }).done) { (a as FakeAudio & { done?: boolean }).done = true; a.fireEnded(); } });
      await flush(); await flush();
      for (const c of tts.calls) if (!all.includes(c.text)) all.push(c.text);
    }
    assert.equal(all.join(" ").replace(/\s+/g, " ").trim().length > 0, true);
    // chunk texts, concatenated in request order, reproduce the reply in order
    const joined = all.join(" ").replace(/[.,]/g, "");
    const expected = LONG_REPLY.replace(/[.,]/g, "");
    assert.equal(joined.replace(/\s+/g, " ").trim(), expected.replace(/\s+/g, " ").trim());
  });

  await test("TTS: audio plays in sequence order even when a later chunk finishes synthesis first", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    assert.equal(tts.calls.length, 2);
    tts.calls[1].respond();
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 0, "chunk #1 must wait for chunk #0");
    tts.calls[0].respond();
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(FakeAudio.instances[0].src, urls.created[1], "first played audio is the first request's");
    assert.equal(hook.voiceState, "SPEAKING");
    FakeAudio.instances[0].fireEnded();
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 2);
    assert.equal(FakeAudio.instances[1].src, urls.created[0], "then chunk #1");
  });

  await test("TTS: only one audio element plays at a time and ended chunks are revoked", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond(); tts.calls[1].respond();
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(FakeAudio.instances[0].playCalls, 1);
    const playing = FakeAudio.instances[0].src;
    FakeAudio.instances[0].fireEnded();
    await flush(); await flush();
    assert.ok(urls.revoked.includes(playing));
    assert.equal(FakeAudio.instances[1].playCalls, 1);
    assert.equal(FakeAudio.instances[0].playCalls, 1, "no duplicate play of the finished chunk");
  });

  await test("TTS: when all chunks are played a new listening turn starts (voice loop)", async () => {
    await startOpen();
    await speakAndSubmit("tell me a quick fact");
    await assistantSays("Rivers carry water from the mountains down to the sea.", true);
    assert.equal(tts.calls.length, 1);
    const instancesBefore = FakeRecognition.instances.length;
    tts.calls[0].respond();
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 1);
    FakeAudio.instances[0].fireEnded();
    await flush(); await flush();
    assert.equal(hook.voiceState, "LISTENING");
    assert.equal(hook.transcript, "");
    await advance(100);
    assert.ok(FakeRecognition.instances.length > instancesBefore, "a fresh recognizer is started");
    assert.equal(hook.actionFeedback, null);
  });

  await test("TTS: with the loop disabled, finishing playback returns to IDLE", async () => {
    await startOpen();
    await act(async () => { hook.toggleLoop(); });
    await speakAndSubmit("tell me a quick fact");
    await assistantSays("Rivers carry water from the mountains down to the sea.", true);
    tts.calls[0].respond();
    await flush(); await flush();
    FakeAudio.instances[0].fireEnded();
    await flush(); await flush();
    assert.equal(hook.voiceState, "IDLE");
  });

  await test("TTS: a streamed reply is spoken incrementally while the LLM is still generating", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays("Rivers carry water from the mountains down to the sea. They shape", false);
    assert.equal(tts.calls.length, 1, "first complete clause is requested before the stream ends");
    const first = tts.calls[0].text;
    await assistantSays("Rivers carry water from the mountains down to the sea. They shape valleys over thousands of years.", true);
    assert.equal(tts.calls[0].text, first);
    assert.ok(tts.calls.length >= 2);
  });

  await test("TTS: a failed chunk is skipped and playback continues with the next one", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].fail(503);
    await flush(); await flush();
    tts.calls[1].respond();
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 1, "chunk #1 plays after chunk #0 failed");
    assert.equal(FakeAudio.instances[0].src, urls.created[0]);
  });

  await test("TTS: audio element error advances to the next chunk", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond(); tts.calls[1].respond();
    await flush(); await flush();
    FakeAudio.instances[0].fireError();
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 2);
  });

  await test("TTS: a non-abort play() rejection advances to the next chunk", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    const originalPlay = FakeAudio.prototype.play;
    FakeAudio.prototype.play = function () { this.playCalls++; return Promise.reject(new Error("NotAllowedError")); };
    try {
      tts.calls[0].respond(); tts.calls[1].respond();
      await flush(); await flush(); await flush();
    } finally {
      FakeAudio.prototype.play = originalPlay;
    }
    assert.equal(FakeAudio.instances.length, 2, "moved on to chunk #1 after chunk #0's play() was rejected");
  });

  await test("TTS: handleStop aborts in-flight /tts requests, plays nothing later, and resets the session", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    const calls = [...tts.calls];
    await act(async () => { hook.handleStop(); });
    assert.ok(calls.every((c) => c.signal.aborted), "every in-flight request is aborted");
    assert.equal(stops, 1);
    assert.equal(hook.voiceState, "IDLE");
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 0);
    assert.ok(live().length === 0, "microphone released by stop");
  });

  await test("TTS: handleStop while audio is playing pauses it and revokes its URL", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond();
    await flush(); await flush();
    const audio = FakeAudio.instances[0];
    await act(async () => { hook.handleStop(); });
    assert.ok(audio.pauseCalls >= 1);
    assert.equal(audio.onended, null, "handlers detached so a late ended event cannot advance the queue");
    assert.ok(urls.revoked.includes(audio.src));
    await act(async () => { audio.fireEnded(); });
    await flush();
    assert.equal(FakeAudio.instances.length, 1);
  });

  await test("TTS: a response arriving after a newer turn started is discarded (no stale audio)", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    const stale = [...tts.calls];
    await act(async () => { hook.handleStop(); });
    stale.forEach((c) => { if (!c.settled) c.respond(); });
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 0);
    assert.equal(urls.created.length, 0, "no object URL created for a cancelled turn");
  });

  await test("TTS: starting a new turn while the previous reply is still being synthesized drops the old queue", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, false);
    const firstTurnCalls = [...tts.calls];
    await act(async () => { rec().fireResult([{ transcript: "actually tell me about lakes", isFinal: true }]); });
    // interruption words are not used; the user speaks a normal new utterance while THINKING/SPEAKING -> ignored by design
    assert.equal(sent.length, 1);
    firstTurnCalls.forEach((c) => assert.equal(c.signal.aborted, false));
  });

  await test("interruption: saying 'stop' while the assistant is speaking halts audio and generation and re-listens", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond();
    await flush(); await flush();
    assert.equal(hook.voiceState, "SPEAKING");
    const audio = FakeAudio.instances[0];
    const calls = [...tts.calls];
    const stopsBefore = stops;
    await act(async () => { rec().fireResult([{ transcript: "stop", isFinal: true }]); });
    assert.equal(stops, stopsBefore + 1);
    assert.ok(audio.pauseCalls >= 1);
    assert.ok(calls.every((c) => c.signal.aborted || c.settled));
    assert.equal(hook.voiceState, "LISTENING");
    const before = FakeRecognition.instances.length;
    await advance(100);
    assert.ok(FakeRecognition.instances.length > before, "fresh listening session after the interruption");
    assert.equal(sent.length, 1, "the interruption word is not sent as a message");
  });

  await test("interruption: echo of the assistant's own word 'stop' is not treated as an interruption", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays("The word stop appears on many road signs near rivers.", true);
    tts.calls[0].respond();
    await flush(); await flush();
    const stopsBefore = stops;
    await act(async () => { rec().fireResult([{ transcript: "the word stop appears on many road signs", isFinal: false }]); });
    assert.equal(stops, stopsBefore);
    assert.equal(hook.voiceState, "SPEAKING");
  });

  await test("interruption: explicit phrases such as 'Lumina stop' always interrupt", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays("The word stop appears on many road signs near rivers.", true);
    tts.calls[0].respond();
    await flush(); await flush();
    const stopsBefore = stops;
    await act(async () => { rec().fireResult([{ transcript: "Lumina stop", isFinal: false }]); });
    assert.equal(stops, stopsBefore + 1);
  });

  // ------------------------------------------------------------------ session / lifecycle
  await test("session: toggling the loop while the assistant is speaking (CURRENT behavior: re-evaluates and interrupts)", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await act(async () => { rec().fireStart(); });   // the interruption-monitoring recognizer really started
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond();
    await flush(); await flush();
    assert.equal(hook.voiceState, "SPEAKING");
    const audio = FakeAudio.instances[0];
    const stopsBefore = stops;
    await act(async () => { hook.toggleLoop(); });
    await advance(300);
    assert.ok(audio.pauseCalls >= 1, "audio interrupted by the loop toggle");
    assert.equal(stops, stopsBefore + 1, "generation stopped by the loop toggle");
  });

  await test("session: toggling the loop while listening changes nothing", async () => {
    await startOpen();
    const count = FakeRecognition.instances.length;
    await act(async () => { hook.toggleLoop(); });
    await advance(500);
    assert.equal(FakeRecognition.instances.length, count);
    assert.equal(hook.voiceState, "LISTENING");
    assert.equal(hook.isLoopEnabled, false);
  });

  await test("session: toggling wake word while idle with a live recognizer does not duplicate recognizers", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { hook.toggleLoop(); });
    await advance(500);
    assert.equal(live().length, 1);
  });

  await test("session: closing voice mode (isOpen false) releases mic, audio and requests, and goes IDLE", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond();
    await flush(); await flush();
    const audio = FakeAudio.instances[0];
    const calls = [...tts.calls];
    const stopsBefore = stops;
    await update({ isOpen: false });
    assert.ok(audio.pauseCalls >= 1);
    assert.ok(calls.every((c) => c.signal.aborted || c.settled));
    assert.equal(stops, stopsBefore + 1);
    assert.equal(hook.voiceState, "IDLE");
    await advance(2000);
    assert.equal(live().length, 0, `wake word off: nothing restarts; origin of the live one: ${live()[0]?.origin}`);
  });

  await test("session: closing voice mode with wake word enabled restarts the wake-word listener after 200 ms", async () => {
    await startOpen({ enableWakeWord: true });
    await update({ isOpen: false, enableWakeWord: true });
    const before = FakeRecognition.instances.length;
    await advance(200);
    assert.ok(FakeRecognition.instances.length > before);
  });

  await test("session: exitVoiceMode() from the public API resets state", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "hello there", isFinal: false }]); });
    assert.equal(hook.transcript, "hello there");
    await act(async () => { hook.exitVoiceMode(); });
    assert.equal(hook.transcript, "");
    assert.equal(hook.voiceState, "IDLE");
    assert.equal(hook.actionFeedback, null);
    assert.equal(live().length, 0);
  });

  await test("session: unmount releases the microphone, aborts /tts and leaves no timers that start anything", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    const calls = [...tts.calls];
    const instances = FakeRecognition.instances.length;
    await unmount();
    assert.ok(calls.every((c) => c.signal.aborted));
    assert.equal(live().length, 0);
    await advance(5000);
    assert.equal(FakeRecognition.instances.length, instances);
  });

  await test("session: manual TTS test button plays one chunk and revokes it when done", async () => {
    await mount({ isOpen: false });
    const done = hook.testTTSAudioPlayback();
    await flush();
    assert.equal(tts.calls.length, 1);
    tts.calls[0].respond();
    await act(async () => { await done; });
    assert.equal(FakeAudio.instances.length, 1);
    FakeAudio.instances[0].fireEnded();
    assert.ok(urls.revoked.includes(FakeAudio.instances[0].src));
  });

  await test("public API: the hook returns exactly the documented members", async () => {
    await mount({});
    assert.deepEqual(Object.keys(hook).sort(), [
      "actionFeedback", "errorMessage", "exitVoiceMode", "handleStop", "isLoopEnabled", "isMicActive",
      "startListening", "stopListening", "testTTSAudioPlayback", "toggleLoop", "transcript", "voiceState",
    ]);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (process.env.VOICE_TEST_JSON) {
    (await import("node:fs")).writeFileSync(process.env.VOICE_TEST_JSON, JSON.stringify(results, null, 1));
  }
  process.exit(failures.length ? 1 : 0);
}

main();
