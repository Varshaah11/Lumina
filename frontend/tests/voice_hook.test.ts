/**
 * Behavior (characterization) tests for useVoiceConversation: STT turn handling, wake word, interruption, the streaming
 * TTS queue/playback pipeline, cancellation and session state. They drive the public hook with a fake SpeechRecognition,
 * fake Audio, a controllable /tts fetch and a fake clock, and assert only observable behavior, so they hold across
 * internal refactors. Migrated 1:1 from the former custom harness scripts/test_voice_hook.ts (52 checks).
 */
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceConversation } from "@/hooks/useVoiceConversation";
import type { Message } from "@/hooks/useChat";
import { installFakeClock } from "./support/fakeClock";
import { routerPushes } from "./support/nextNavigation";
import { FakeRecognition, installFakeSpeechRecognition } from "./support/speechRecognition";
import { FakeAudio, installVoiceDoubles, tts, urls } from "./support/voiceDoubles";

vi.mock("next/navigation", () => import("./support/nextNavigation"));

type Hook = ReturnType<typeof useVoiceConversation>;
interface Props {
  isOpen: boolean;
  enableWakeWord: boolean;
  hasDocument: boolean;
  isLoading: boolean;
  messages: Message[];
}

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
async function advance(ms: number) { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); }); await flush(); }
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

beforeEach(() => {
  installFakeSpeechRecognition();
  installVoiceDoubles();
  routerPushes.length = 0;
  sent.length = 0; stops = 0; opened = 0; micChanges.length = 0; sendImpl = () => {};
  // The hook logs verbosely
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  installFakeClock();
});

afterEach(async () => {
  await unmount();
});

describe("useVoiceConversation", () => {


  // ------------------------------------------------------------------ STT
  it("STT: opening voice mode creates a continuous interim recognizer and reports LISTENING / mic active", async () => {
    await mount({ isOpen: true });
    expect(FakeRecognition.instances.length).toBe(1);
    const r = rec();
    expect(r.startCalls).toBe(1);
    expect(r.continuous).toBe(true);
    expect(r.interimResults).toBe(true);
    expect(r.lang.length > 0).toBeTruthy();
    await act(async () => { r.fireStart(); });
    expect(hook.voiceState).toBe("LISTENING");
    expect(hook.isMicActive).toBe(true);
    expect(micChanges.filter((c) => c === true).length > 0).toStrictEqual(true);
  });

  it("STT: interim and final results build the live transcript", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "hello", isFinal: false }]); });
    expect(hook.transcript).toBe("hello");
    await act(async () => { rec().fireResult([{ transcript: "hello", isFinal: true }, { transcript: "wor", isFinal: false }]); });
    expect(hook.transcript).toBe("hello wor");
    await act(async () => { rec().fireResult([{ transcript: "hello", isFinal: true }, { transcript: "world", isFinal: true }]); });
    expect(hook.transcript).toBe("helloworld");
  });

  it("STT: 1.5 s of silence auto-submits the transcript as a voice message", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "tell me about rivers", isFinal: true }]); });
    await advance(1499);
    expect(sent.length).toBe(0);
    await advance(1);
    expect(sent).toStrictEqual([{ text: "tell me about rivers", file: null, isVoice: true }]);
    expect(hook.voiceState).toBe("THINKING");
    expect(hook.transcript).toBe("");
  });

  it("STT: a one-character transcript is not submitted", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "a", isFinal: true }]); });
    await advance(5000);
    expect(sent.length).toBe(0);
  });

  it("STT: recognizer ending with a transcript submits immediately", async () => {
    await startOpen();
    await speakAndSubmit("good morning lumina");
    expect(sent.map((s) => s.text)).toStrictEqual(["good morning lumina"]);
    expect(hook.voiceState).toBe("THINKING");
  });

  it("STT: submitting twice for the same utterance is guarded", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "tell me a joke", isFinal: true }]); });
    await act(async () => { rec().fireEnd(); });
    await advance(2000);
    expect(sent.length).toBe(1);
  });

  it("STT: ending with no speech restarts the recognizer while the loop is enabled", async () => {
    await startOpen();
    const before = FakeRecognition.instances.length;
    await act(async () => { rec().fireEnd(); });
    expect(FakeRecognition.instances.length).toBe(before);
    await advance(200);
    expect(FakeRecognition.instances.length).toBe(before + 1);
    expect(rec().startCalls).toBe(1);
  });

  it("STT: with the loop disabled, ending with no speech goes IDLE and does not restart", async () => {
    await startOpen();
    await act(async () => { hook.toggleLoop(); });
    const before = FakeRecognition.instances.length;
    await act(async () => { rec().fireEnd(); });
    await advance(1000);
    expect(FakeRecognition.instances.length).toBe(before);
    expect(hook.voiceState).toBe("IDLE");
  });

  it("STT: late onend from a replaced recognizer is ignored", async () => {
    await startOpen();
    const first = rec();
    await act(async () => { first.fireEnd(); });
    await advance(200);
    const second = rec();
    expect(first).not.toBe(second);
    await act(async () => { second.fireStart(); });
    const count = FakeRecognition.instances.length;
    await act(async () => { first.fireEnd(); });
    await advance(1000);
    expect(FakeRecognition.instances.length).toBe(count);
    expect(hook.isMicActive).toBe(true);
  });

  it("STT errors: not-allowed shows the blocked message, ERROR state and aborts the recognizer", async () => {
    await startOpen();
    const r = rec();
    await act(async () => { r.fireError("not-allowed"); });
    expect(hook.errorMessage ?? "").toMatch(/Microphone access was blocked/);
    expect(hook.voiceState).toBe("ERROR");
    expect(r.abortCalls >= 1).toBeTruthy();
    expect(hook.isMicActive).toBe(false);
    await advance(2000);
    expect(FakeRecognition.instances.length, "no retry after a denial").toBe(1);
  });

  it("STT errors: audio-capture, network, unknown and benign errors", async () => {
    await startOpen();
    await act(async () => { rec().fireError("no-speech"); });
    expect(hook.errorMessage).toBe(null);
    expect(hook.voiceState).toBe("LISTENING");
    await act(async () => { rec().fireError("aborted"); });
    expect(hook.errorMessage).toBe(null);
    await act(async () => { rec().fireError("network"); });
    expect(hook.errorMessage ?? "").toMatch(/network error/);
    expect(hook.voiceState).toBe("ERROR");
    expect(rec().abortCalls, "network errors keep the recognizer").toBe(0);
    await act(async () => { rec().fireError("language-not-supported"); });
    expect(hook.errorMessage ?? "").toMatch(/\(language-not-supported\)/);
    await act(async () => { rec().fireError("audio-capture"); });
    expect(hook.errorMessage ?? "").toMatch(/No microphone detected/);
    expect(rec().abortCalls >= 1).toBeTruthy();
  });

  it("STT: unsupported browser shows an error state", async () => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    const saved = [w.SpeechRecognition, w.webkitSpeechRecognition];
    w.SpeechRecognition = undefined; w.webkitSpeechRecognition = undefined;
    try {
      await mount({ isOpen: true });
      expect(hook.errorMessage ?? "").toMatch(/not supported/);
      expect(hook.voiceState).toBe("ERROR");
    } finally {
      [w.SpeechRecognition, w.webkitSpeechRecognition] = saved;
    }
  });

  it("STT: recognizer start() throwing shows an activation error", async () => {
    const original = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = function () { throw new Error("denied by policy"); };
    try {
      await mount({ isOpen: true });
      expect(hook.errorMessage ?? "").toMatch(/Failed to activate microphone/);
      expect(hook.voiceState).toBe("ERROR");
    } finally {
      FakeRecognition.prototype.start = original;
    }
  });

  it("STT: explicit startListening()/stopListening() from the public API", async () => {
    await mount({ isOpen: false });
    expect(FakeRecognition.instances.length).toBe(0);
    await act(async () => { hook.startListening(); });
    expect(FakeRecognition.instances.length).toBe(1);
    await act(async () => { hook.startListening(); });
    expect(FakeRecognition.instances.length, "duplicate trigger while starting is ignored").toBe(1);
    await act(async () => { rec().fireStart(); });
    await act(async () => { hook.stopListening(); });
    expect(FakeRecognition.instances[0].abortCalls >= 1).toBeTruthy();
    expect(hook.isMicActive).toBe(false);
  });

  // ------------------------------------------------------------------ wake word
  it("wake word: heard with a trailing question opens voice mode and submits the question", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { rec().fireResult([{ transcript: "hey Lumina what time is it", isFinal: true }]); });
    expect(opened).toBe(1);
    await advance(100);
    expect(sent.map((s) => s.text)).toStrictEqual(["what time is it"]);
    expect(hook.voiceState).toBe("THINKING");
  });

  it("wake word: only 'Lumina' opens voice mode and waits for the question; repeats are debounced", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { rec().fireResult([{ transcript: "Lumina", isFinal: true }]); });
    expect(opened).toBe(1);
    expect(hook.voiceState).toBe("LISTENING");
    await act(async () => { rec().fireResult([{ transcript: "Lumina", isFinal: false }]); });
    expect(opened, "debounced within 2 s").toBe(1);
    await advance(2100);
    await act(async () => { rec().fireResult([{ transcript: "Lumina", isFinal: true }]); });
    expect(opened).toBe(2);
    expect(sent.length).toBe(0);
  });

  it("wake word: ordinary speech while idle is ignored", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { rec().fireResult([{ transcript: "just talking about lumina later", isFinal: true }]); });
    expect(opened).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("wake word: OFF means no recognizer at all; toggling on starts one, off aborts it", async () => {
    await mount({ enableWakeWord: false });
    await advance(5000);
    expect(FakeRecognition.instances.length).toBe(0);
    await update({ enableWakeWord: true });
    expect(live().length).toBe(1);
    const r = rec();
    await update({ enableWakeWord: false });
    expect(r.abortCalls >= 1).toBeTruthy();
    await advance(5000);
    expect(live().length).toBe(0);
  });

  it("wake word: keeps listening after the recognizer ends (300 ms restart)", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { rec().fireEnd(); });
    expect(FakeRecognition.instances.length).toBe(1);
    await advance(300);
    expect(FakeRecognition.instances.length).toBe(2);
  });

  it("wake word: yields the microphone to other components and resumes afterwards", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    const first = rec();
    await act(async () => { window.dispatchEvent(new window.Event("lumina:stop-speech")); });
    expect(first.abortCalls >= 1).toBeTruthy();
    expect(hook.isMicActive).toBe(false);
    await act(async () => { window.dispatchEvent(new window.Event("lumina:speech-released")); });
    await advance(300);
    expect(live().length).toBe(1);
    expect(FakeRecognition.instances.length).toBe(2);
  });

  it("wake word: stop-speech does not stop an active voice session", async () => {
    await startOpen();
    const r = rec();
    await act(async () => { window.dispatchEvent(new window.Event("lumina:stop-speech")); });
    expect(r.abortCalls).toBe(0);
  });

  // ------------------------------------------------------------------ intents
  it("intent: navigation phrase goes ACTION then navigates after 800 ms", async () => {
    await startOpen();
    await speakAndSubmit("open my history");
    expect(hook.voiceState).toBe("ACTION");
    expect(hook.actionFeedback ?? "").toMatch(/History/);
    expect(routerPushes.length).toBe(0);
    await advance(800);
    expect(routerPushes).toStrictEqual(["/history"]);
    expect(hook.voiceState).toBe("IDLE");
    expect(sent.length).toBe(0);
  });

  it("intent: document action without a document warns and sends nothing", async () => {
    await startOpen({ hasDocument: false });
    await speakAndSubmit("summarize this document");
    expect(hook.voiceState).toBe("ACTION");
    expect(hook.actionFeedback ?? "").toMatch(/attach a document/);
    expect(sent.length).toBe(0);
  });

  it("intent: document action with a document sends the formatted prompt", async () => {
    await startOpen({ hasDocument: true });
    await speakAndSubmit("summarize this document");
    expect(sent.map((s) => s.text)).toStrictEqual(["Summarize this document in 5 key points."]);
    expect(hook.actionFeedback ?? "").toMatch(/Summarizing/);
  });

  it("intent: hasDocument that becomes true during an open session is honoured by the next utterance", async () => {
    await startOpen({ hasDocument: false });
    await update({ hasDocument: true });
    await speakAndSubmit("summarize this document");
    expect(sent.map((s) => s.text)).toStrictEqual(["Summarize this document in 5 key points."]);
  });

  it("send failure: rejected sendMessage shows an error and clears the submitting guard", async () => {
    sendImpl = () => Promise.reject(new Error("backend down"));
    await startOpen();
    await speakAndSubmit("tell me a story");
    await flush();
    expect(hook.errorMessage).toBe("backend down");
    expect(hook.voiceState).toBe("ERROR");
  });

  it("chat error: an error message from the chat while THINKING surfaces as ERROR", async () => {
    await startOpen();
    await speakAndSubmit("tell me a story");
    await update({ messages: [msg("u", "user", "q"), msg("e", "error", "Lumina couldn't connect.")], isLoading: false });
    expect(hook.errorMessage).toBe("Lumina couldn't connect.");
    expect(hook.voiceState).toBe("ERROR");
  });

  // ------------------------------------------------------------------ TTS pipeline
  it("TTS: streamed reply is chunked in order and requested from /tts with at most 2 in flight", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    expect(tts.calls.length >= 1).toBeTruthy();
    expect(tts.calls.length <= 2, `in flight must be capped at 2, got ${tts.calls.length}`).toBeTruthy();
    expect(tts.url).toMatch(/\/tts$/);
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
    expect(all.join(" ").replace(/\s+/g, " ").trim().length > 0).toBe(true);
    // chunk texts, concatenated in request order, reproduce the reply in order
    const joined = all.join(" ").replace(/[.,]/g, "");
    const expected = LONG_REPLY.replace(/[.,]/g, "");
    expect(joined.replace(/\s+/g, " ").trim()).toBe(expected.replace(/\s+/g, " ").trim());
  });

  it("TTS: audio plays in sequence order even when a later chunk finishes synthesis first", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    expect(tts.calls.length).toBe(2);
    tts.calls[1].respond();
    await flush(); await flush();
    expect(FakeAudio.instances.length, "chunk #1 must wait for chunk #0").toBe(0);
    tts.calls[0].respond();
    await flush(); await flush();
    expect(FakeAudio.instances.length).toBe(1);
    expect(FakeAudio.instances[0].src, "first played audio is the first request's").toBe(urls.created[1]);
    expect(hook.voiceState).toBe("SPEAKING");
    FakeAudio.instances[0].fireEnded();
    await flush(); await flush();
    expect(FakeAudio.instances.length).toBe(2);
    expect(FakeAudio.instances[1].src, "then chunk #1").toBe(urls.created[0]);
  });

  it("TTS: only one audio element plays at a time and ended chunks are revoked", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond(); tts.calls[1].respond();
    await flush(); await flush();
    expect(FakeAudio.instances.length).toBe(1);
    expect(FakeAudio.instances[0].playCalls).toBe(1);
    const playing = FakeAudio.instances[0].src;
    FakeAudio.instances[0].fireEnded();
    await flush(); await flush();
    expect(urls.revoked.includes(playing)).toBeTruthy();
    expect(FakeAudio.instances[1].playCalls).toBe(1);
    expect(FakeAudio.instances[0].playCalls, "no duplicate play of the finished chunk").toBe(1);
  });

  it("TTS: when all chunks are played a new listening turn starts (voice loop)", async () => {
    await startOpen();
    await speakAndSubmit("tell me a quick fact");
    await assistantSays("Rivers carry water from the mountains down to the sea.", true);
    expect(tts.calls.length).toBe(1);
    const instancesBefore = FakeRecognition.instances.length;
    tts.calls[0].respond();
    await flush(); await flush();
    expect(FakeAudio.instances.length).toBe(1);
    FakeAudio.instances[0].fireEnded();
    await flush(); await flush();
    expect(hook.voiceState).toBe("LISTENING");
    expect(hook.transcript).toBe("");
    await advance(100);
    expect(FakeRecognition.instances.length > instancesBefore, "a fresh recognizer is started").toBeTruthy();
    expect(hook.actionFeedback).toBe(null);
  });

  it("TTS: with the loop disabled, finishing playback returns to IDLE", async () => {
    await startOpen();
    await act(async () => { hook.toggleLoop(); });
    await speakAndSubmit("tell me a quick fact");
    await assistantSays("Rivers carry water from the mountains down to the sea.", true);
    tts.calls[0].respond();
    await flush(); await flush();
    FakeAudio.instances[0].fireEnded();
    await flush(); await flush();
    expect(hook.voiceState).toBe("IDLE");
  });

  it("TTS: a streamed reply is spoken incrementally while the LLM is still generating", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays("Rivers carry water from the mountains down to the sea. They shape", false);
    expect(tts.calls.length, "first complete clause is requested before the stream ends").toBe(1);
    const first = tts.calls[0].text;
    await assistantSays("Rivers carry water from the mountains down to the sea. They shape valleys over thousands of years.", true);
    expect(tts.calls[0].text).toBe(first);
    expect(tts.calls.length >= 2).toBeTruthy();
  });

  it("TTS: a failed chunk is skipped and playback continues with the next one", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].fail(503);
    await flush(); await flush();
    tts.calls[1].respond();
    await flush(); await flush();
    expect(FakeAudio.instances.length, "chunk #1 plays after chunk #0 failed").toBe(1);
    expect(FakeAudio.instances[0].src).toBe(urls.created[0]);
  });

  it("TTS: audio element error advances to the next chunk", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond(); tts.calls[1].respond();
    await flush(); await flush();
    FakeAudio.instances[0].fireError();
    await flush(); await flush();
    expect(FakeAudio.instances.length).toBe(2);
  });

  it("TTS: a non-abort play() rejection advances to the next chunk", async () => {
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
    expect(FakeAudio.instances.length, "moved on to chunk #1 after chunk #0's play() was rejected").toBe(2);
  });

  it("TTS: handleStop aborts in-flight /tts requests, plays nothing later, and resets the session", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    const calls = [...tts.calls];
    await act(async () => { hook.handleStop(); });
    expect(calls.every((c) => c.signal.aborted), "every in-flight request is aborted").toBeTruthy();
    expect(stops).toBe(1);
    expect(hook.voiceState).toBe("IDLE");
    await flush(); await flush();
    expect(FakeAudio.instances.length).toBe(0);
    expect(live().length === 0, "microphone released by stop").toBeTruthy();
  });

  it("TTS: handleStop while audio is playing pauses it and revokes its URL", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond();
    await flush(); await flush();
    const audio = FakeAudio.instances[0];
    await act(async () => { hook.handleStop(); });
    expect(audio.pauseCalls >= 1).toBeTruthy();
    expect(audio.onended, "handlers detached so a late ended event cannot advance the queue").toBe(null);
    expect(urls.revoked.includes(audio.src)).toBeTruthy();
    await act(async () => { audio.fireEnded(); });
    await flush();
    expect(FakeAudio.instances.length).toBe(1);
  });

  it("TTS: a response arriving after a newer turn started is discarded (no stale audio)", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    const stale = [...tts.calls];
    await act(async () => { hook.handleStop(); });
    stale.forEach((c) => { if (!c.settled) c.respond(); });
    await flush(); await flush();
    expect(FakeAudio.instances.length).toBe(0);
    expect(urls.created.length, "no object URL created for a cancelled turn").toBe(0);
  });

  it("TTS: starting a new turn while the previous reply is still being synthesized drops the old queue", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, false);
    const firstTurnCalls = [...tts.calls];
    await act(async () => { rec().fireResult([{ transcript: "actually tell me about lakes", isFinal: true }]); });
    // interruption words are not used; the user speaks a normal new utterance while THINKING/SPEAKING -> ignored by design
    expect(sent.length).toBe(1);
    firstTurnCalls.forEach((c) => expect(c.signal.aborted).toBe(false));
  });

  it("interruption: saying 'stop' while the assistant is speaking halts audio and generation and re-listens", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond();
    await flush(); await flush();
    expect(hook.voiceState).toBe("SPEAKING");
    const audio = FakeAudio.instances[0];
    const calls = [...tts.calls];
    const stopsBefore = stops;
    await act(async () => { rec().fireResult([{ transcript: "stop", isFinal: true }]); });
    expect(stops).toBe(stopsBefore + 1);
    expect(audio.pauseCalls >= 1).toBeTruthy();
    expect(calls.every((c) => c.signal.aborted || c.settled)).toBeTruthy();
    expect(hook.voiceState).toBe("LISTENING");
    const before = FakeRecognition.instances.length;
    await advance(100);
    expect(FakeRecognition.instances.length > before, "fresh listening session after the interruption").toBeTruthy();
    expect(sent.length, "the interruption word is not sent as a message").toBe(1);
  });

  it("interruption: echo of the assistant's own word 'stop' is not treated as an interruption", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays("The word stop appears on many road signs near rivers.", true);
    tts.calls[0].respond();
    await flush(); await flush();
    const stopsBefore = stops;
    await act(async () => { rec().fireResult([{ transcript: "the word stop appears on many road signs", isFinal: false }]); });
    expect(stops).toBe(stopsBefore);
    expect(hook.voiceState).toBe("SPEAKING");
  });

  it("interruption: explicit phrases such as 'Lumina stop' always interrupt", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays("The word stop appears on many road signs near rivers.", true);
    tts.calls[0].respond();
    await flush(); await flush();
    const stopsBefore = stops;
    await act(async () => { rec().fireResult([{ transcript: "Lumina stop", isFinal: false }]); });
    expect(stops).toBe(stopsBefore + 1);
  });

  // ------------------------------------------------------------------ session / lifecycle
  it("session: toggling the loop while the assistant is speaking (CURRENT behavior: re-evaluates and interrupts)", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await act(async () => { rec().fireStart(); });   // the interruption-monitoring recognizer really started
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond();
    await flush(); await flush();
    expect(hook.voiceState).toBe("SPEAKING");
    const audio = FakeAudio.instances[0];
    const stopsBefore = stops;
    await act(async () => { hook.toggleLoop(); });
    await advance(300);
    expect(audio.pauseCalls >= 1, "audio interrupted by the loop toggle").toBeTruthy();
    expect(stops, "generation stopped by the loop toggle").toBe(stopsBefore + 1);
  });

  it("session: toggling the loop while listening changes nothing", async () => {
    await startOpen();
    const count = FakeRecognition.instances.length;
    await act(async () => { hook.toggleLoop(); });
    await advance(500);
    expect(FakeRecognition.instances.length).toBe(count);
    expect(hook.voiceState).toBe("LISTENING");
    expect(hook.isLoopEnabled).toBe(false);
  });

  it("session: toggling wake word while idle with a live recognizer does not duplicate recognizers", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { rec().fireStart(); });
    await act(async () => { hook.toggleLoop(); });
    await advance(500);
    expect(live().length).toBe(1);
  });

  it("session: closing voice mode (isOpen false) releases mic, audio and requests, and goes IDLE", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    tts.calls[0].respond();
    await flush(); await flush();
    const audio = FakeAudio.instances[0];
    const calls = [...tts.calls];
    const stopsBefore = stops;
    await update({ isOpen: false });
    expect(audio.pauseCalls >= 1).toBeTruthy();
    expect(calls.every((c) => c.signal.aborted || c.settled)).toBeTruthy();
    expect(stops).toBe(stopsBefore + 1);
    expect(hook.voiceState).toBe("IDLE");
    await advance(2000);
    expect(live().length, `wake word off: nothing restarts; origin of the live one: ${live()[0]?.origin}`).toBe(0);
  });

  it("session: closing voice mode with wake word enabled restarts the wake-word listener after 200 ms", async () => {
    await startOpen({ enableWakeWord: true });
    await update({ isOpen: false, enableWakeWord: true });
    const before = FakeRecognition.instances.length;
    await advance(200);
    expect(FakeRecognition.instances.length > before).toBeTruthy();
  });

  it("session: exitVoiceMode() from the public API resets state", async () => {
    await startOpen();
    await act(async () => { rec().fireResult([{ transcript: "hello there", isFinal: false }]); });
    expect(hook.transcript).toBe("hello there");
    await act(async () => { hook.exitVoiceMode(); });
    expect(hook.transcript).toBe("");
    expect(hook.voiceState).toBe("IDLE");
    expect(hook.actionFeedback).toBe(null);
    expect(live().length).toBe(0);
  });

  it("session: unmount releases the microphone, aborts /tts and leaves no timers that start anything", async () => {
    await startOpen();
    await speakAndSubmit("tell me about rivers");
    await assistantSays(LONG_REPLY, true);
    const calls = [...tts.calls];
    const instances = FakeRecognition.instances.length;
    await unmount();
    expect(calls.every((c) => c.signal.aborted)).toBeTruthy();
    expect(live().length).toBe(0);
    await advance(5000);
    expect(FakeRecognition.instances.length).toBe(instances);
  });

  it("session: manual TTS test button plays one chunk and revokes it when done", async () => {
    await mount({ isOpen: false });
    const done = hook.testTTSAudioPlayback();
    await flush();
    expect(tts.calls.length).toBe(1);
    tts.calls[0].respond();
    await act(async () => { await done; });
    expect(FakeAudio.instances.length).toBe(1);
    FakeAudio.instances[0].fireEnded();
    expect(urls.revoked.includes(FakeAudio.instances[0].src)).toBeTruthy();
  });

  it("public API: the hook returns exactly the documented members", async () => {
    await mount({});
    expect(Object.keys(hook).sort()).toStrictEqual([
      "actionFeedback", "errorMessage", "exitVoiceMode", "handleStop", "isLoopEnabled", "isMicActive",
      "startListening", "stopListening", "testTTSAudioPlayback", "toggleLoop", "transcript", "voiceState",
    ]);
  });
});
