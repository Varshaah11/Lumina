/**
 * Unit tests for the extracted voice modules (no React): TtsPipeline queue/playback and SttController. They pin the
 * queue guarantees the refactor relies on: strict ordering, bounded in-flight requests, no duplicates, no stale-turn
 * audio, no restarts after stop. Run from frontend/:
 *   OUT=$(mktemp -d) && npx tsc -p scripts/tsconfig.test.json --outDir $OUT \
 *     && cp scripts/next_navigation_stub.js $OUT/scripts/ && NODE_PATH=$PWD/node_modules node $OUT/scripts/test_voice_modules.js
 */
import { FakeRecognition } from "./mic_test_support";
import { FakeAudio, FakeClock, resetVoiceShims, tts as ttsFetch, urls } from "./voice_test_support";
import assert from "node:assert/strict";
import { extractStreamingTTSChunks, isMeaningfulSpeechChunk } from "../lib/voice/chunker";
import { MAX_IN_FLIGHT_TTS, TtsPipeline, type TtsPipelineHost } from "../lib/voice/ttsPipeline";
import { SttController, type SttHost } from "../lib/voice/sttController";

const clock = new FakeClock();
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

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  FakeRecognition.instances.length = 0;
  resetVoiceShims();
  clock.install();
  const log = console.log; const warn = console.warn; const err = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  let error: Error | null = null;
  try { await fn(); } catch (e) { error = e as Error; }
  clock.uninstall();
  console.log = log; console.warn = warn; console.error = err;
  if (error) { failures.push(name); console.log(`  [FAIL] ${name}\n         ${error.message.split("\n")[0]}`); }
  else { passed++; console.log(`  [PASS] ${name}`); }
}

async function main() {
  console.log("\n=== Voice module tests ===");

  // ------------------------------------------------------------------ chunker
  await test("chunker: meaningful-chunk rules", () => {
    assert.equal(isMeaningfulSpeechChunk(""), false);
    assert.equal(isMeaningfulSpeechChunk("ab"), false);
    assert.equal(isMeaningfulSpeechChunk("12 34"), false);
    assert.equal(isMeaningfulSpeechChunk("Hello there."), true);
  });

  await test("chunker: incremental extraction never repeats or drops text", () => {
    let processed = 0;
    const out: string[] = [];
    for (let upto = 10; upto <= REPLY.length + 10; upto += 7) {
      const isComplete = upto >= REPLY.length;
      for (const c of extractStreamingTTSChunks(REPLY.slice(0, upto), processed, isComplete)) { processed += c.rawLength; out.push(c.text); }
    }
    assert.equal(out.join(" ").replace(/\s+/g, " "), REPLY);
  });

  // ------------------------------------------------------------------ TTS pipeline: ordering & bounds
  await test("pipeline: never more than MAX_IN_FLIGHT_TTS requests at once and strictly ordered playback", async () => {
    const { pipeline, events } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    assert.equal(ttsFetch.calls.length, MAX_IN_FLIGHT_TTS);
    assert.equal(pipeline.inFlight, MAX_IN_FLIGHT_TTS);
    // answer the second request first
    ttsFetch.calls[1].respond();
    await settle();
    assert.equal(FakeAudio.instances.length, 0);
    ttsFetch.calls[0].respond();
    await settle();
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(events[0], "start");
    // the third chunk is only requested once a slot frees up
    assert.ok(ttsFetch.calls.length >= 3);
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
    assert.equal(requested.join(" ").replace(/\s+/g, " "), REPLY);
    assert.equal(events[events.length - 1], "done");
    assert.equal(events.filter((e) => e === "done").length, 1, "completion is reported exactly once");
    assert.equal(FakeAudio.instances.length, ttsFetch.calls.length, "one audio element per chunk, no duplicates");
    assert.equal(new Set(FakeAudio.instances.map((a) => a.src)).size, FakeAudio.instances.length);
  });

  await test("pipeline: feeding the same growing text repeatedly never re-queues a chunk (no duplicate audio)", async () => {
    const { pipeline } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY.slice(0, 60), false);
    const first = ttsFetch.calls.length;
    for (let i = 0; i < 5; i++) pipeline.feedAssistantText(REPLY.slice(0, 60), false);
    assert.equal(ttsFetch.calls.length, first);
    pipeline.feedAssistantText(REPLY, true);
    for (let i = 0; i < 5; i++) pipeline.feedAssistantText(REPLY, true);
    const texts = ttsFetch.calls.map((c) => c.text);
    assert.equal(new Set(texts).size, texts.length, "every chunk requested at most once");
  });

  await test("pipeline: nothing is fetched while voice mode is not active", () => {
    const { pipeline } = makePipeline({ value: false });
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    assert.equal(ttsFetch.calls.length, 0);
  });

  await test("pipeline: a failed chunk is skipped, later chunks still play, completion still fires", async () => {
    const { pipeline, events } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText("Rivers carry water from the mountains down to the sea. They shape valleys over thousands of years.", true);
    assert.equal(ttsFetch.calls.length, 2);
    ttsFetch.calls[0].fail(500);
    ttsFetch.calls[1].respond();
    await settle();
    assert.equal(FakeAudio.instances.length, 1);
    FakeAudio.instances[0].fireEnded();
    await settle();
    assert.equal(events[events.length - 1], "done");
  });

  // ------------------------------------------------------------------ TTS pipeline: stale data & cancellation
  await test("pipeline: a response from a previous turn can never enter the new turn's queue (sequence numbers restart per turn)", async () => {
    const { pipeline, events } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText("Rivers carry water from the mountains down to the sea.", true);
    const oldCall = ttsFetch.calls[0];
    pipeline.interrupt();                     // turn A is invalidated
    pipeline.startTurn();                     // turn B: its first chunk is ALSO sequence #0
    pipeline.feedAssistantText("Lakes are large bodies of still fresh water on land.", true);
    const newCall = ttsFetch.calls[ttsFetch.calls.length - 1];
    assert.notEqual(oldCall, newCall);
    assert.ok(oldCall.signal.aborted, "old request aborted");
    oldCall.respond();                        // arrives late (ignored: already rejected by abort)
    await settle();
    assert.equal(FakeAudio.instances.length, 0, "stale audio must not play");
    newCall.respond();
    await settle();
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(FakeAudio.instances[0].src, urls.created[urls.created.length - 1]);
    assert.deepEqual(events, ["start"]);
  });

  await test("pipeline: a response that resolves after the turn was invalidated (before any abort took effect) is discarded", async () => {
    const { pipeline } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText("Rivers carry water from the mountains down to the sea.", true);
    pipeline.invalidateTurn();                // invalidated without cleanup(): only the turn guard protects us
    ttsFetch.calls[0].respond();
    await settle();
    assert.equal(FakeAudio.instances.length, 0);
    assert.equal(urls.created.length, 0, "no object URL created for an invalidated turn");
    assert.equal(pipeline.inFlight, 0);
    assert.equal(pipeline.audioReadyDepth, 0);
  });

  await test("pipeline: late 'ended' of an invalidated chunk does not advance the new turn", async () => {
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
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(events.includes("done"), false);
  });

  await test("pipeline: cleanup aborts requests, pauses audio, revokes URLs, empties queues and is idempotent", async () => {
    const { pipeline } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    ttsFetch.calls[0].respond();
    await settle();
    const audio = FakeAudio.instances[0];
    const pending = ttsFetch.calls.filter((c) => !c.settled);
    pipeline.cleanup();
    assert.ok(pending.every((c) => c.signal.aborted));
    assert.ok(audio.pauseCalls >= 1);
    assert.equal(audio.onended, null);
    assert.ok(urls.revoked.includes(audio.src));
    assert.equal(pipeline.isPlaying, false);
    assert.equal(pipeline.inFlight, 0);
    assert.equal(pipeline.audioReadyDepth, 0);
    assert.equal(pipeline.currentChunkText, "");
    const revoked = urls.revoked.length;
    pipeline.cleanup();
    assert.equal(urls.revoked.length, revoked, "second cleanup revokes nothing more");
  });

  await test("pipeline: voice mode closing mid-synthesis discards results", async () => {
    const active = { value: true };
    const { pipeline } = makePipeline(active);
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    active.value = false;
    ttsFetch.calls.forEach((c) => c.respond());
    await settle();
    assert.equal(FakeAudio.instances.length, 0);
    assert.equal(pipeline.inFlight, 0, "in-flight counter released for discarded responses");
  });

  await test("pipeline: only one chunk plays at a time", async () => {
    const { pipeline } = makePipeline();
    pipeline.startTurn();
    pipeline.feedAssistantText(REPLY, true);
    ttsFetch.calls.forEach((c) => c.respond());
    await settle();
    assert.equal(FakeAudio.instances.filter((a) => a.playCalls > 0 && a.onended).length, 1);
  });

  await test("pipeline: speech synthesis fallback is cancelled on interrupt", () => {
    const calls: string[] = [];
    (window as unknown as { speechSynthesis: { cancel(): void } }).speechSynthesis = { cancel: () => calls.push("cancel") };
    try {
      makePipeline().pipeline.interrupt();
      assert.deepEqual(calls, ["cancel"]);
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

  await test("stt: constructing the controller never touches the microphone (and works with no host attached)", () => {
    makeStt();
    const bare = new SttController();
    bare.stop();
    assert.equal(bare.isListening, false);
    assert.equal(FakeRecognition.instances.length, 0);
  });

  await test("stt: begin() starts exactly one continuous recognizer; start/end/error events reach the host", () => {
    const { stt, log } = makeStt();
    stt.begin();
    assert.equal(FakeRecognition.instances.length, 1);
    assert.equal(rec().startCalls, 1);
    assert.equal(rec().continuous, true);
    assert.equal(stt.isStarting, true);
    rec().fireStart();
    assert.deepEqual(log.slice(-2), ["mic:true", "started"]);
    assert.equal(stt.isListening, true);
    assert.equal(stt.isStarting, false);
    rec().fireError("network");
    assert.equal(log[log.length - 1], "error:network");
    assert.equal(stt.isListening, false);
    rec().fireEnd();
    assert.equal(log[log.length - 1], `ended:${stt.sessionId}`);
    assert.equal(log[log.length - 2], "mic:false");
  });

  await test("stt: no-speech is benign (no error callback, still listening)", () => {
    const { stt, log } = makeStt();
    stt.begin(); rec().fireStart();
    rec().fireError("no-speech");
    assert.equal(log.some((l) => l.startsWith("error:")), false);
    assert.equal(stt.isListening, true);
  });

  await test("stt: stop() releases the recognizer, detaches handlers, and late events are ignored", () => {
    const { stt, log } = makeStt();
    stt.begin(); const r = rec(); r.fireStart();
    stt.stop();
    assert.ok(r.abortCalls >= 1);
    assert.equal(r.onend, null); assert.equal(r.onresult, null); assert.equal(r.onerror, null); assert.equal(r.onstart, null);
    assert.equal(stt.hasRecognition, false);
    assert.equal(stt.isListening, false);
    const before = log.length;
    r.fireEnd?.();
    assert.equal(log.length, before, "no host callbacks after stop");
  });

  await test("stt: events from a replaced recognizer (older session) are ignored", () => {
    const { stt, log, transcripts } = makeStt();
    stt.begin(); const first = rec();
    stt.begin(); const second = rec();
    assert.notEqual(first, second);
    assert.ok(first.abortCalls >= 1);
    const sessionBefore = stt.sessionId;
    // simulate the browser delivering events from the old instance anyway (handlers were detached, so call stale ones directly)
    first.onstart?.(); first.onend?.();
    assert.equal(log.includes("started"), false);
    assert.equal(log.includes(`ended:${sessionBefore - 1}`), false);
    assert.equal(transcripts.length, 0);
  });

  await test("stt: invalidateSession() makes the live recognizer's handlers stale", () => {
    const { stt, log } = makeStt();
    stt.begin(); const r = rec(); r.fireStart();
    stt.invalidateSession();
    const before = log.length;
    r.fireEnd();
    assert.equal(log.length, before);
  });

  await test("stt: transcript assembly is isolated per turn", () => {
    const { stt, transcripts } = makeStt();
    stt.begin(); rec().fireStart();
    rec().fireResult([{ transcript: "hello", isFinal: true }]);
    assert.equal(stt.latestTranscript, "hello");
    stt.beginNextTurn();                        // utterance submitted
    assert.equal(stt.latestTranscript, "");
    rec().fireResult([{ transcript: "hello", isFinal: true }, { transcript: "again", isFinal: false }]);
    assert.equal(stt.latestTranscript, "again", "results before the turn boundary are excluded");
    stt.resetTurn();
    rec().fireResult([{ transcript: "hello", isFinal: true }, { transcript: "again", isFinal: true }]);
    assert.equal(stt.latestTranscript, "helloagain");
    assert.deepEqual(transcripts.map((t) => t[0]), ["hello", "again", "helloagain"]);
  });

  await test("stt: silence timer fires once, is replaced when re-armed and cleared by stop()", () => {
    const { stt } = makeStt();
    let fired = 0;
    stt.armSilenceTimer(1500, () => fired++);
    stt.armSilenceTimer(1500, () => fired++);
    clock.advance(1499);
    assert.equal(fired, 0);
    clock.advance(1);
    assert.equal(fired, 1);
    stt.armSilenceTimer(1500, () => fired++);
    stt.stop();
    clock.advance(5000);
    assert.equal(fired, 1);
  });

  await test("stt: unsupported browser and a throwing start() are reported to the host", () => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    const saved = [w.SpeechRecognition, w.webkitSpeechRecognition];
    w.SpeechRecognition = undefined; w.webkitSpeechRecognition = undefined;
    const a = makeStt();
    a.stt.begin();
    [w.SpeechRecognition, w.webkitSpeechRecognition] = saved;
    assert.deepEqual(a.log, ["unsupported"]);
    const original = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = function () { throw new Error("blocked"); };
    try {
      const b = makeStt();
      b.stt.begin();
      assert.equal(b.log.includes("startFailed"), true);
      assert.equal(b.stt.isStarting, false);
      assert.equal(b.stt.isListening, false);
    } finally {
      FakeRecognition.prototype.start = original;
    }
  });

  await test("stt: simulateResult feeds the live recognizer", () => {
    const { stt, transcripts } = makeStt();
    stt.begin(); rec().fireStart();
    stt.simulateResult("test phrase");
    assert.equal(transcripts[0][0], "test phrase");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main();
