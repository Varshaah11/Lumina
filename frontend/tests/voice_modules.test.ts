/**
 * Unit tests for the extracted voice modules (no React): TtsPipeline queue/playback and SttController. They pin the
 * queue guarantees the refactor relies on: strict ordering, bounded in-flight requests, no duplicates, no stale-turn
 * audio, no restarts after stop. Migrated 1:1 from the former custom harness scripts/test_voice_modules.ts (23 checks).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractStreamingTTSChunks, isMeaningfulSpeechChunk } from "@/lib/voice/chunker";
import { MAX_IN_FLIGHT_TTS, TtsPipeline, type TtsPipelineHost } from "@/lib/voice/ttsPipeline";
import { SttController, type SttHost } from "@/lib/voice/sttController";
import { installFakeClock } from "./support/fakeClock";
import { FakeRecognition, installFakeSpeechRecognition } from "./support/speechRecognition";
import { FakeAudio, installVoiceDoubles, tts as ttsFetch, urls } from "./support/voiceDoubles";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 5; i++) await tick(); }

const REPLY = "Rivers carry water from the mountains down to the sea. They shape valleys over thousands of years. Many cities grew along their banks.";

function makePipeline(active = { value: true }) {
  const events: string[] = [];
  const host: TtsPipelineHost = {
    isVoiceActive: () => active.value,
    onChunkPlaybackStart: () => { events.push("start"); },
    onAllChunksPlayed: () => { events.push("done"); },
  };
  const pipeline = new TtsPipeline();
  pipeline.attachHost(host);
  return { pipeline, events, active };
}

beforeEach(() => {
  installFakeSpeechRecognition();
  installVoiceDoubles();
  installFakeClock();
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

describe("voice modules", () => {


  // ------------------------------------------------------------------ chunker
  it("chunker: meaningful-chunk rules", () => {
    expect(isMeaningfulSpeechChunk("")).toBe(false);
    expect(isMeaningfulSpeechChunk("ab")).toBe(false);
    expect(isMeaningfulSpeechChunk("12 34")).toBe(false);
    expect(isMeaningfulSpeechChunk("Hello there.")).toBe(true);
  });

  it("chunker: incremental extraction never repeats or drops text", () => {
    let processed = 0;
    const out: string[] = [];
    for (let upto = 10; upto <= REPLY.length + 10; upto += 7) {
      const isComplete = upto >= REPLY.length;
      for (const c of extractStreamingTTSChunks(REPLY.slice(0, upto), processed, isComplete)) { processed += c.rawLength; out.push(c.text); }
    }
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(REPLY);
  });

  // ------------------------------------------------------------------ TTS pipeline: ordering & bounds
  it("pipeline: never more than MAX_IN_FLIGHT_TTS requests at once and strictly ordered playback", async () => {
    const { pipeline, events } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    expect(ttsFetch.calls.length).toBe(MAX_IN_FLIGHT_TTS);
    expect(pipeline.inFlight).toBe(MAX_IN_FLIGHT_TTS);
    // answer the second request first
    ttsFetch.calls[1].respond();
    await settle();
    expect(FakeAudio.instances.length).toBe(0);
    ttsFetch.calls[0].respond();
    await settle();
    expect(FakeAudio.instances.length).toBe(1);
    expect(events[0]).toBe("start");
    // the third chunk is only requested once a slot frees up
    expect(ttsFetch.calls.length >= 3).toBeTruthy();
    // play everything to the end, in order
    const requested: string[] = [];
    for (let guard = 0; guard < 10 && events[events.length - 1] !== "done"; guard++) {
      ttsFetch.calls.filter((c) => !c.settled).forEach((c) => c.respond());
      await settle();
      const playing = FakeAudio.instances[FakeAudio.instances.length - 1];
      if (playing && playing.onended) playing.fireEnded();
      await settle();
    }
    for (const c of ttsFetch.calls) requested.push(c.text);
    expect(requested.join(" ").replace(/\s+/g, " ")).toBe(REPLY);
    expect(events[events.length - 1]).toBe("done");
    expect(events.filter((e) => e === "done").length, "completion is reported exactly once").toBe(1);
    expect(FakeAudio.instances.length, "one audio element per chunk, no duplicates").toBe(ttsFetch.calls.length);
    expect(new Set(FakeAudio.instances.map((a) => a.src)).size).toBe(FakeAudio.instances.length);
  });

  it("pipeline: feeding the same growing text repeatedly never re-queues a chunk (no duplicate audio)", async () => {
    const { pipeline } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY.slice(0, 60), false);
    const first = ttsFetch.calls.length;
    for (let i = 0; i < 5; i++) pipeline.feedAssistantText(REPLY.slice(0, 60), false);
    expect(ttsFetch.calls.length).toBe(first);
    pipeline.feedAssistantText(REPLY, true);
    for (let i = 0; i < 5; i++) pipeline.feedAssistantText(REPLY, true);
    const texts = ttsFetch.calls.map((c) => c.text);
    expect(new Set(texts).size, "every chunk requested at most once").toBe(texts.length);
  });

  it("pipeline: nothing is fetched while voice mode is not active", () => {
    const { pipeline } = makePipeline({ value: false });
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    expect(ttsFetch.calls.length).toBe(0);
  });

  it("pipeline: a failed chunk is skipped, later chunks still play, completion still fires", async () => {
    const { pipeline, events } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText("Rivers carry water from the mountains down to the sea. They shape valleys over thousands of years.", true);
    expect(ttsFetch.calls.length).toBe(2);
    ttsFetch.calls[0].fail(500);
    ttsFetch.calls[1].respond();
    await settle();
    expect(FakeAudio.instances.length).toBe(1);
    FakeAudio.instances[0].fireEnded();
    await settle();
    expect(events[events.length - 1]).toBe("done");
  });

  // ------------------------------------------------------------------ TTS pipeline: stale data & cancellation
  it("pipeline: a response from a previous turn can never enter the new turn's queue (sequence numbers restart per turn)", async () => {
    const { pipeline, events } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText("Rivers carry water from the mountains down to the sea.", true);
    const oldCall = ttsFetch.calls[0];
    pipeline.interrupt();                     // turn A is invalidated
    pipeline.startTurn();                     // turn B: its first chunk is ALSO sequence #0
    pipeline.feedAssistantText("Lakes are large bodies of still fresh water on land.", true);
    const newCall = ttsFetch.calls[ttsFetch.calls.length - 1];
    expect(oldCall).not.toBe(newCall);
    expect(oldCall.signal.aborted, "old request aborted").toBeTruthy();
    oldCall.respond();                        // arrives late (ignored: already rejected by abort)
    await settle();
    expect(FakeAudio.instances.length, "stale audio must not play").toBe(0);
    newCall.respond();
    await settle();
    expect(FakeAudio.instances.length).toBe(1);
    expect(FakeAudio.instances[0].src).toBe(urls.created[urls.created.length - 1]);
    expect(events).toStrictEqual(["start"]);
  });

  it("pipeline: a response that resolves after the turn was invalidated (before any abort took effect) is discarded", async () => {
    const { pipeline } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText("Rivers carry water from the mountains down to the sea.", true);
    pipeline.invalidateTurn();                // invalidated without cleanup(): only the turn guard protects us
    ttsFetch.calls[0].respond();
    await settle();
    expect(FakeAudio.instances.length).toBe(0);
    expect(urls.created.length, "no object URL created for an invalidated turn").toBe(0);
    expect(pipeline.inFlight).toBe(0);
    expect(pipeline.audioReadyDepth).toBe(0);
  });

  it("pipeline: late 'ended' of an invalidated chunk does not advance the new turn", async () => {
    const { pipeline, events } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText("Rivers carry water from the mountains down to the sea. They shape valleys over thousands of years.", true);
    ttsFetch.calls[0].respond();
    await settle();
    const audio = FakeAudio.instances[0];
    const endedHandler = audio.onended;
    pipeline.interrupt();
    pipeline.startTurn();
    endedHandler?.();                         // a stale ended event arriving after the interruption
    await settle();
    expect(FakeAudio.instances.length).toBe(1);
    expect(events.includes("done")).toBe(false);
  });

  it("pipeline: cleanup aborts requests, pauses audio, revokes URLs, empties queues and is idempotent", async () => {
    const { pipeline } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    ttsFetch.calls[0].respond();
    await settle();
    const audio = FakeAudio.instances[0];
    const pending = ttsFetch.calls.filter((c) => !c.settled);
    pipeline.cleanup();
    expect(pending.every((c) => c.signal.aborted)).toBeTruthy();
    expect(audio.pauseCalls >= 1).toBeTruthy();
    expect(audio.onended).toBe(null);
    expect(urls.revoked.includes(audio.src)).toBeTruthy();
    expect(pipeline.isPlaying).toBe(false);
    expect(pipeline.inFlight).toBe(0);
    expect(pipeline.audioReadyDepth).toBe(0);
    expect(pipeline.currentChunkText).toBe("");
    const revoked = urls.revoked.length;
    pipeline.cleanup();
    expect(urls.revoked.length, "second cleanup revokes nothing more").toBe(revoked);
  });

  it("pipeline: voice mode closing mid-synthesis discards results", async () => {
    const active = { value: true };
    const { pipeline } = makePipeline(active);
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    active.value = false;
    ttsFetch.calls.forEach((c) => c.respond());
    await settle();
    expect(FakeAudio.instances.length).toBe(0);
    expect(pipeline.inFlight, "in-flight counter released for discarded responses").toBe(0);
  });

  it("pipeline: only one chunk plays at a time", async () => {
    const { pipeline } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    ttsFetch.calls.forEach((c) => c.respond());
    await settle();
    expect(FakeAudio.instances.filter((a) => a.playCalls > 0 && a.onended).length).toBe(1);
  });

  it("pipeline: speech synthesis fallback is cancelled on interrupt", () => {
    const calls: string[] = [];
    (window as unknown as { speechSynthesis: { cancel(): void } }).speechSynthesis = { cancel: () => calls.push("cancel") };
    try {
      makePipeline().pipeline.interrupt();
      expect(calls).toStrictEqual(["cancel"]);
    } finally {
      delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    }
  });

  // ------------------------------------------------------------------ STT controller
  function makeStt() {
    const log: string[] = [];
    const transcripts: [string, number][] = [];
    const host: SttHost = {
      onMicActiveChange: (a) => log.push(`mic:${a}`),
      onStarted: () => log.push("started"),
      onTranscript: (t, id) => transcripts.push([t, id]),
      onError: (e) => log.push(`error:${e}`),
      onEnded: (id) => log.push(`ended:${id}`),
      onUnsupported: () => log.push("unsupported"),
      onStartFailed: () => log.push("startFailed"),
    };
    const stt = new SttController();
    stt.attachHost(host);
    return { stt, log, transcripts };
  }
  const rec = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];

  it("stt: constructing the controller never touches the microphone (and works with no host attached)", () => {
    makeStt();
    const bare = new SttController();
    bare.stop();
    expect(bare.isListening).toBe(false);
    expect(FakeRecognition.instances.length).toBe(0);
  });

  it("stt: begin() starts exactly one continuous recognizer; start/end/error events reach the host", () => {
    const { stt, log } = makeStt();
    stt.begin();
    expect(FakeRecognition.instances.length).toBe(1);
    expect(rec().startCalls).toBe(1);
    expect(rec().continuous).toBe(true);
    expect(stt.isStarting).toBe(true);
    rec().fireStart();
    expect(log.slice(-2)).toStrictEqual(["mic:true", "started"]);
    expect(stt.isListening).toBe(true);
    expect(stt.isStarting).toBe(false);
    rec().fireError("network");
    expect(log[log.length - 1]).toBe("error:network");
    expect(stt.isListening).toBe(false);
    rec().fireEnd();
    expect(log[log.length - 1]).toBe(`ended:${stt.sessionId}`);
    expect(log[log.length - 2]).toBe("mic:false");
  });

  it("stt: no-speech is benign (no error callback, still listening)", () => {
    const { stt, log } = makeStt();
    stt.begin(); rec().fireStart();
    rec().fireError("no-speech");
    expect(log.some((l) => l.startsWith("error:"))).toBe(false);
    expect(stt.isListening).toBe(true);
  });

  it("stt: stop() releases the recognizer, detaches handlers, and late events are ignored", () => {
    const { stt, log } = makeStt();
    stt.begin(); const r = rec(); r.fireStart();
    stt.stop();
    expect(r.abortCalls >= 1).toBeTruthy();
    expect(r.onend).toBe(null); expect(r.onresult).toBe(null); expect(r.onerror).toBe(null); expect(r.onstart).toBe(null);
    expect(stt.hasRecognition).toBe(false);
    expect(stt.isListening).toBe(false);
    const before = log.length;
    r.fireEnd?.();
    expect(log.length, "no host callbacks after stop").toBe(before);
  });

  it("stt: events from a replaced recognizer (older session) are ignored", () => {
    const { stt, log, transcripts } = makeStt();
    stt.begin(); const first = rec();
    stt.begin(); const second = rec();
    expect(first).not.toBe(second);
    expect(first.abortCalls >= 1).toBeTruthy();
    const sessionBefore = stt.sessionId;
    // simulate the browser delivering events from the old instance anyway (handlers were detached, so call stale ones directly)
    first.onstart?.(); first.onend?.();
    expect(log.includes("started")).toBe(false);
    expect(log.includes(`ended:${sessionBefore - 1}`)).toBe(false);
    expect(transcripts.length).toBe(0);
  });

  it("stt: invalidateSession() makes the live recognizer's handlers stale", () => {
    const { stt, log } = makeStt();
    stt.begin(); const r = rec(); r.fireStart();
    stt.invalidateSession();
    const before = log.length;
    r.fireEnd();
    expect(log.length).toBe(before);
  });

  it("stt: transcript assembly is isolated per turn", () => {
    const { stt, transcripts } = makeStt();
    stt.begin(); rec().fireStart();
    rec().fireResult([{ transcript: "hello", isFinal: true }]);
    expect(stt.latestTranscript).toBe("hello");
    stt.beginNextTurn();                        // utterance submitted
    expect(stt.latestTranscript).toBe("");
    rec().fireResult([{ transcript: "hello", isFinal: true }, { transcript: "again", isFinal: false }]);
    expect(stt.latestTranscript, "results before the turn boundary are excluded").toBe("again");
    stt.resetTurn();
    rec().fireResult([{ transcript: "hello", isFinal: true }, { transcript: "again", isFinal: true }]);
    expect(stt.latestTranscript).toBe("helloagain");
    expect(transcripts.map((t) => t[0])).toStrictEqual(["hello", "again", "helloagain"]);
  });

  it("stt: silence timer fires once, is replaced when re-armed and cleared by stop()", () => {
    const { stt } = makeStt();
    let fired = 0;
    stt.armSilenceTimer(1500, () => fired++);
    stt.armSilenceTimer(1500, () => fired++);
    vi.advanceTimersByTime(1499);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    stt.armSilenceTimer(1500, () => fired++);
    stt.stop();
    vi.advanceTimersByTime(5000);
    expect(fired).toBe(1);
  });

  it("stt: unsupported browser and a throwing start() are reported to the host", () => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    const saved = [w.SpeechRecognition, w.webkitSpeechRecognition];
    w.SpeechRecognition = undefined; w.webkitSpeechRecognition = undefined;
    const a = makeStt();
    a.stt.begin();
    [w.SpeechRecognition, w.webkitSpeechRecognition] = saved;
    expect(a.log).toStrictEqual(["unsupported"]);
    const original = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = function () { throw new Error("blocked"); };
    try {
      const b = makeStt();
      b.stt.begin();
      expect(b.log.includes("startFailed")).toBe(true);
      expect(b.stt.isStarting).toBe(false);
      expect(b.stt.isListening).toBe(false);
    } finally {
      FakeRecognition.prototype.start = original;
    }
  });

  it("stt: simulateResult feeds the live recognizer", () => {
    const { stt, transcripts } = makeStt();
    stt.begin(); rec().fireStart();
    stt.simulateResult("test phrase");
    expect(transcripts[0][0]).toBe("test phrase");
  });
});
