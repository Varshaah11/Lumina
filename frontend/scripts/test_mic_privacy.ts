/**
 * Microphone privacy tests: the microphone is OFF by default, starts only after an explicit user action, is released
 * when disabled/unmounted, never restarts after refresh/navigation, and the UI reflects the real state.
 *
 * Lumina uses the browser Web Speech API (SpeechRecognition); there is no getUserMedia/MediaStream in the app, so
 * "stopping the tracks" means aborting the recognizer. Run from frontend/ (no test runner is installed):
 *   OUT=$(mktemp -d) && npx tsc -p scripts/tsconfig.test.json --outDir $OUT \
 *     && cp scripts/next_navigation_stub.js $OUT/scripts/ && NODE_PATH=$PWD/node_modules node $OUT/scripts/test_mic_privacy.js
 */
import { FakeRecognition, mediaCalls } from "./mic_test_support";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { useVoiceConversation } from "../hooks/useVoiceConversation";
import { MicStatusIndicator } from "../components/chat/MicStatusIndicator";

type HookProps = { isOpen?: boolean; enableWakeWord?: boolean | "omit"; onMicActiveChange?: (a: boolean) => void };
let latest: ReturnType<typeof useVoiceConversation>;

function Harness(props: HookProps) {
  const { enableWakeWord, isOpen = false, ...rest } = props;
  // eslint-disable-next-line react-hooks/globals -- test harness exposes the hook's latest result
  latest = useVoiceConversation({
    sendMessage: () => {},
    stopGeneration: () => {},
    isLoading: false,
    messages: [],
    isOpen,
    ...(enableWakeWord === "omit" ? {} : { enableWakeWord }),
    ...rest,
  });
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => { await sleep(700); });   // longer than every restart timer in the hook
let root: Root | null = null;
const live = () => FakeRecognition.instances.filter((i) => !i.released);

async function mount(props: HookProps) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(React.createElement(Harness, props)); });
}
async function rerender(props: HookProps) {
  await act(async () => { root!.render(React.createElement(Harness, props)); });
}
async function unmount() {
  await act(async () => { root!.unmount(); });
  root = null;
}
function reset() {
  FakeRecognition.instances.length = 0;
  mediaCalls.getUserMedia = 0;
}

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  reset();
  const log = console.log;
  console.log = () => {};   // the hook logs verbosely
  let error: Error | null = null;
  try {
    await fn();
  } catch (e) {
    error = e as Error;
  }
  if (root) { try { await unmount(); } catch {} }
  console.log = log;
  if (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}\n         ${error.message}`);
  } else {
    passed++;
    console.log(`  [PASS] ${name}`);
  }
}

function readSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "scripts"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readSources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function main() {
  console.log("\n=== Microphone privacy tests ===");

  // ---- OFF by default / no permission request on load ----
  await test("microphone is not requested on initial render (wake word off)", async () => {
    await mount({ isOpen: false, enableWakeWord: false });
    await settle();
    assert.equal(FakeRecognition.instances.length, 0, "no recognizer may be created");
    assert.equal(mediaCalls.getUserMedia, 0);
    assert.equal(latest.isMicActive, false);
  });

  await test("microphone is OFF by default when enableWakeWord is omitted", async () => {
    await mount({ isOpen: false, enableWakeWord: "omit" });
    await settle();
    assert.equal(FakeRecognition.instances.length, 0);
    assert.equal(latest.isMicActive, false);
  });

  await test("no restart timers start the microphone while idle", async () => {
    await mount({ isOpen: false, enableWakeWord: false });
    await rerender({ isOpen: false, enableWakeWord: false });
    await settle();
    assert.equal(FakeRecognition.instances.length, 0);
  });

  // ---- explicit opt-in ----
  await test("microphone starts only after the explicit wake-word opt-in", async () => {
    await mount({ enableWakeWord: false });
    assert.equal(FakeRecognition.instances.length, 0);
    await rerender({ enableWakeWord: true });          // the user pressed "Turn on"
    assert.equal(FakeRecognition.instances.length, 1);
    assert.equal(FakeRecognition.instances[0].startCalls, 1);
    assert.equal(latest.isMicActive, false, "not 'active' until the browser actually starts capturing");
    await act(async () => { FakeRecognition.instances[0].fireStart(); });
    assert.equal(latest.isMicActive, true);
  });

  await test("explicit startListening() (e.g. Start Talking) starts exactly one recognizer", async () => {
    await mount({ enableWakeWord: false });
    await act(async () => { latest.startListening(); });
    assert.equal(FakeRecognition.instances.length, 1);
    assert.equal(FakeRecognition.instances[0].startCalls, 1);
  });

  await test("opening voice mode (explicit) starts listening; closing releases the microphone", async () => {
    await mount({ isOpen: false, enableWakeWord: false });
    assert.equal(FakeRecognition.instances.length, 0);
    await rerender({ isOpen: true, enableWakeWord: false });
    assert.ok(FakeRecognition.instances.length >= 1, "voice mode still works once opened by the user");
    await act(async () => { live().forEach((i) => i.fireStart()); });
    assert.equal(latest.isMicActive, true);
    await rerender({ isOpen: false, enableWakeWord: false });
    await settle();
    assert.equal(live().length, 0, "closing voice mode must release the microphone");
    assert.equal(latest.isMicActive, false);
  });

  // ---- release ----
  await test("disabling listening aborts the recognizer and does not restart", async () => {
    const changes: boolean[] = [];
    await mount({ enableWakeWord: true, onMicActiveChange: (a) => changes.push(a) });
    const first = FakeRecognition.instances[0];
    await act(async () => { first.fireStart(); });
    assert.equal(latest.isMicActive, true);
    await rerender({ enableWakeWord: false, onMicActiveChange: (a) => changes.push(a) });   // user pressed "Turn off"
    assert.ok(first.abortCalls >= 1, "recognizer must be aborted");
    assert.equal(first.onend, null, "handlers detached so a late onend cannot restart it");
    await act(async () => { first.fireEnd(); });       // a late event from the browser
    await settle();
    assert.equal(FakeRecognition.instances.length, 1, "no new recognizer after disabling");
    assert.equal(latest.isMicActive, false);
    assert.deepEqual(changes.slice(-1), [false]);
  });

  await test("unmount while listening aborts the recognizer and nothing restarts", async () => {
    await mount({ enableWakeWord: true });
    const rec = FakeRecognition.instances[0];
    await act(async () => { rec.fireStart(); });
    await unmount();
    assert.ok(rec.abortCalls >= 1, "unmount must release the microphone");
    await act(async () => { rec.fireEnd(); });
    await settle();
    assert.equal(FakeRecognition.instances.length, 1, "no recognizer created after unmount");
    assert.equal(live().length, 0);
  });

  await test("explicit stopListening() aborts the recognizer", async () => {
    await mount({ enableWakeWord: false });
    await act(async () => { latest.startListening(); });
    await act(async () => { FakeRecognition.instances[0].fireStart(); });
    await act(async () => { latest.stopListening(); });
    assert.ok(FakeRecognition.instances[0].abortCalls >= 1);
    assert.equal(latest.isMicActive, false);
  });

  await test("permission denied: microphone is released and not retried", async () => {
    await mount({ enableWakeWord: true });
    const rec = FakeRecognition.instances[0];
    await act(async () => { rec.fireError("not-allowed"); });
    await settle();
    assert.ok(rec.released);
    assert.equal(FakeRecognition.instances.length, 1, "no retry loop after a denial");
    assert.equal(latest.isMicActive, false);
  });

  // ---- existing opt-in behavior still works ----
  await test("when opted in, a browser-ended session restarts (hands-free continues)", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { FakeRecognition.instances[0].fireStart(); });
    await act(async () => { FakeRecognition.instances[0].fireEnd(); });
    await settle();
    assert.equal(FakeRecognition.instances.length, 2);
    assert.equal(FakeRecognition.instances[1].startCalls, 1);
  });

  // ---- refresh / navigation ----
  await test("navigation away releases the microphone; coming back starts OFF (nothing resumes)", async () => {
    await mount({ enableWakeWord: true });                       // user enabled it on the dashboard
    const rec = FakeRecognition.instances[0];
    await act(async () => { rec.fireStart(); });
    await unmount();                                             // navigate to another page
    assert.ok(rec.released);
    await mount({ isOpen: false, enableWakeWord: false });       // back on the dashboard: state resets to its default (OFF)
    await settle();
    assert.equal(FakeRecognition.instances.length, 1, "no new recognizer after returning");
    assert.equal(live().length, 0);
  });

  await test("page refresh (fresh mount with defaults) never auto-starts the microphone", async () => {
    await mount({ enableWakeWord: "omit" });
    await unmount();
    await mount({ enableWakeWord: "omit" });
    await settle();
    assert.equal(FakeRecognition.instances.length, 0);
  });

  await test("source: dashboard wake word defaults to false and nothing persists mic state", () => {
    const projectRoot = process.env.LUMINA_FRONTEND_DIR || path.resolve(process.cwd());
    const dashboard = fs.readFileSync(path.join(projectRoot, "app/dashboard/page.tsx"), "utf8");
    assert.match(dashboard, /\[isWakeWordEnabled,\s*setIsWakeWordEnabled\]\s*=\s*useState\(false\)/);
    assert.doesNotMatch(dashboard, /useState\(true\)\s*;?\s*\n?.*WakeWord/);
    const files = readSources(projectRoot);
    assert.ok(files.length > 30);
    const offenders = files.filter((f) => /localStorage|sessionStorage|indexedDB|document\.cookie/.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(offenders, [], "wake word / mic preference must not be persisted anywhere");
    const hook = fs.readFileSync(path.join(projectRoot, "hooks/useVoiceConversation.ts"), "utf8");
    assert.match(hook, /enableWakeWord = false/);
    assert.doesNotMatch(hook, /getUserMedia/);
  });

  // ---- UI indication ----
  await test("indicator: off by default (grey, 'Microphone off', offers Turn on)", () => {
    const html = renderToStaticMarkup(React.createElement(MicStatusIndicator, { enabled: false, active: false, onToggle() {} }));
    assert.match(html, /Microphone off/);
    assert.match(html, /data-mic-active="false"/);
    assert.match(html, /Turn on/);
    assert.doesNotMatch(html, /bg-red-500|animate-pulse/);
  });

  await test("indicator: enabled but not yet capturing shows a waiting state, not 'listening'", () => {
    const html = renderToStaticMarkup(React.createElement(MicStatusIndicator, { enabled: true, active: false, onToggle() {} }));
    assert.match(html, /Waiting for microphone access/);
    assert.match(html, /data-mic-active="false"/);
    assert.doesNotMatch(html, /Microphone ON/);
  });

  await test("indicator: actively listening is unmistakable (red pulsing dot, 'Microphone ON', offers Turn off)", () => {
    const html = renderToStaticMarkup(React.createElement(MicStatusIndicator, { enabled: true, active: true, onToggle() {} }));
    assert.match(html, /Microphone ON/);
    assert.match(html, /data-mic-active="true"/);
    assert.match(html, /bg-red-500 animate-pulse/);
    assert.match(html, /Turn off/);
    assert.match(html, /role="status"/);
  });

  await test("indicator state follows the hook's real microphone state", async () => {
    const seen: string[] = [];
    function Panel(props: { enabled: boolean }) {
      const [active, setActive] = React.useState(false);
      const v = useVoiceConversation({
        sendMessage: () => {}, stopGeneration: () => {}, isLoading: false, messages: [], isOpen: false,
        enableWakeWord: props.enabled, onMicActiveChange: setActive,
      });
      void v;
      seen.push(active ? "ON" : "OFF");
      return React.createElement(MicStatusIndicator, { enabled: props.enabled, active, onToggle() {} });
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = createRoot(container);
    root = r;
    await act(async () => { r.render(React.createElement(Panel, { enabled: false })); });
    assert.match(container.innerHTML, /Microphone off/);
    await act(async () => { r.render(React.createElement(Panel, { enabled: true })); });
    assert.match(container.innerHTML, /Waiting for microphone access/);
    await act(async () => { FakeRecognition.instances[0].fireStart(); });
    assert.match(container.innerHTML, /Microphone ON — listening/);
    await act(async () => { r.render(React.createElement(Panel, { enabled: false })); });
    assert.match(container.innerHTML, /Microphone off/);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main();
