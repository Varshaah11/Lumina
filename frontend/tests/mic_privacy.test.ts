/**
 * Microphone privacy tests: the microphone is OFF by default, starts only after an explicit user action, is released
 * when disabled/unmounted, never restarts after refresh/navigation, and the UI reflects the real state.
 *
 * Lumina uses the browser Web Speech API (SpeechRecognition); there is no getUserMedia/MediaStream in the app, so
 * "stopping the tracks" means aborting the recognizer. Migrated 1:1 from the former custom harness scripts/test_mic_privacy.ts (18 checks).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicStatusIndicator } from "@/components/chat/MicStatusIndicator";
import { useVoiceConversation } from "@/hooks/useVoiceConversation";
import { installFakeClock } from "./support/fakeClock";
import { FakeRecognition, installFakeSpeechRecognition, mediaCalls } from "./support/speechRecognition";

vi.mock("next/navigation", () => import("./support/nextNavigation"));

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

// Longer than every restart timer in the hook (the original harness slept 700 ms of real time)
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(700); });
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

/** Application sources only: dependencies, build output and test code are skipped. */
function readSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "scripts", "tests"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readSources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

beforeEach(() => {
  installFakeSpeechRecognition();
  vi.spyOn(console, "log").mockImplementation(() => {});   // the hook logs verbosely
  installFakeClock();
});

afterEach(async () => {
  if (root) await unmount();
});

describe("microphone privacy", () => {


  // ---- OFF by default / no permission request on load ----
  it("microphone is not requested on initial render (wake word off)", async () => {
    await mount({ isOpen: false, enableWakeWord: false });
    await settle();
    expect(FakeRecognition.instances.length, "no recognizer may be created").toBe(0);
    expect(mediaCalls.getUserMedia).toBe(0);
    expect(latest.isMicActive).toBe(false);
  });

  it("microphone is OFF by default when enableWakeWord is omitted", async () => {
    await mount({ isOpen: false, enableWakeWord: "omit" });
    await settle();
    expect(FakeRecognition.instances.length).toBe(0);
    expect(latest.isMicActive).toBe(false);
  });

  it("no restart timers start the microphone while idle", async () => {
    await mount({ isOpen: false, enableWakeWord: false });
    await rerender({ isOpen: false, enableWakeWord: false });
    await settle();
    expect(FakeRecognition.instances.length).toBe(0);
  });

  // ---- explicit opt-in ----
  it("microphone starts only after the explicit wake-word opt-in", async () => {
    await mount({ enableWakeWord: false });
    expect(FakeRecognition.instances.length).toBe(0);
    await rerender({ enableWakeWord: true });          // the user pressed "Turn on"
    expect(FakeRecognition.instances.length).toBe(1);
    expect(FakeRecognition.instances[0].startCalls).toBe(1);
    expect(latest.isMicActive, "not 'active' until the browser actually starts capturing").toBe(false);
    await act(async () => { FakeRecognition.instances[0].fireStart(); });
    expect(latest.isMicActive).toBe(true);
  });

  it("explicit startListening() (e.g. Start Talking) starts exactly one recognizer", async () => {
    await mount({ enableWakeWord: false });
    await act(async () => { latest.startListening(); });
    expect(FakeRecognition.instances.length).toBe(1);
    expect(FakeRecognition.instances[0].startCalls).toBe(1);
  });

  it("opening voice mode (explicit) starts listening; closing releases the microphone", async () => {
    await mount({ isOpen: false, enableWakeWord: false });
    expect(FakeRecognition.instances.length).toBe(0);
    await rerender({ isOpen: true, enableWakeWord: false });
    expect(FakeRecognition.instances.length >= 1, "voice mode still works once opened by the user").toBeTruthy();
    await act(async () => { live().forEach((i) => i.fireStart()); });
    expect(latest.isMicActive).toBe(true);
    await rerender({ isOpen: false, enableWakeWord: false });
    await settle();
    expect(live().length, "closing voice mode must release the microphone").toBe(0);
    expect(latest.isMicActive).toBe(false);
  });

  // ---- release ----
  it("disabling listening aborts the recognizer and does not restart", async () => {
    const changes: boolean[] = [];
    await mount({ enableWakeWord: true, onMicActiveChange: (a) => changes.push(a) });
    const first = FakeRecognition.instances[0];
    await act(async () => { first.fireStart(); });
    expect(latest.isMicActive).toBe(true);
    await rerender({ enableWakeWord: false, onMicActiveChange: (a) => changes.push(a) });   // user pressed "Turn off"
    expect(first.abortCalls >= 1, "recognizer must be aborted").toBeTruthy();
    expect(first.onend, "handlers detached so a late onend cannot restart it").toBe(null);
    await act(async () => { first.fireEnd(); });       // a late event from the browser
    await settle();
    expect(FakeRecognition.instances.length, "no new recognizer after disabling").toBe(1);
    expect(latest.isMicActive).toBe(false);
    expect(changes.slice(-1)).toStrictEqual([false]);
  });

  it("unmount while listening aborts the recognizer and nothing restarts", async () => {
    await mount({ enableWakeWord: true });
    const rec = FakeRecognition.instances[0];
    await act(async () => { rec.fireStart(); });
    await unmount();
    expect(rec.abortCalls >= 1, "unmount must release the microphone").toBeTruthy();
    await act(async () => { rec.fireEnd(); });
    await settle();
    expect(FakeRecognition.instances.length, "no recognizer created after unmount").toBe(1);
    expect(live().length).toBe(0);
  });

  it("explicit stopListening() aborts the recognizer", async () => {
    await mount({ enableWakeWord: false });
    await act(async () => { latest.startListening(); });
    await act(async () => { FakeRecognition.instances[0].fireStart(); });
    await act(async () => { latest.stopListening(); });
    expect(FakeRecognition.instances[0].abortCalls >= 1).toBeTruthy();
    expect(latest.isMicActive).toBe(false);
  });

  it("permission denied: microphone is released and not retried", async () => {
    await mount({ enableWakeWord: true });
    const rec = FakeRecognition.instances[0];
    await act(async () => { rec.fireError("not-allowed"); });
    await settle();
    expect(rec.released).toBeTruthy();
    expect(FakeRecognition.instances.length, "no retry loop after a denial").toBe(1);
    expect(latest.isMicActive).toBe(false);
  });

  // ---- existing opt-in behavior still works ----
  it("when opted in, a browser-ended session restarts (hands-free continues)", async () => {
    await mount({ enableWakeWord: true });
    await act(async () => { FakeRecognition.instances[0].fireStart(); });
    await act(async () => { FakeRecognition.instances[0].fireEnd(); });
    await settle();
    expect(FakeRecognition.instances.length).toBe(2);
    expect(FakeRecognition.instances[1].startCalls).toBe(1);
  });

  // ---- refresh / navigation ----
  it("navigation away releases the microphone; coming back starts OFF (nothing resumes)", async () => {
    await mount({ enableWakeWord: true });                       // user enabled it on the dashboard
    const rec = FakeRecognition.instances[0];
    await act(async () => { rec.fireStart(); });
    await unmount();                                             // navigate to another page
    expect(rec.released).toBeTruthy();
    await mount({ isOpen: false, enableWakeWord: false });       // back on the dashboard: state resets to its default (OFF)
    await settle();
    expect(FakeRecognition.instances.length, "no new recognizer after returning").toBe(1);
    expect(live().length).toBe(0);
  });

  it("page refresh (fresh mount with defaults) never auto-starts the microphone", async () => {
    await mount({ enableWakeWord: "omit" });
    await unmount();
    await mount({ enableWakeWord: "omit" });
    await settle();
    expect(FakeRecognition.instances.length).toBe(0);
  });

  it("source: dashboard wake word defaults to false and nothing persists mic state", () => {
    const projectRoot = FRONTEND_ROOT;
    const dashboard = fs.readFileSync(path.join(projectRoot, "app/dashboard/page.tsx"), "utf8");
    expect(dashboard).toMatch(/\[isWakeWordEnabled,\s*setIsWakeWordEnabled\]\s*=\s*useState\(false\)/);
    expect(dashboard).not.toMatch(/useState\(true\)\s*;?\s*\n?.*WakeWord/);
    const files = readSources(projectRoot);
    expect(files.length > 30).toBeTruthy();
    const offenders = files.filter((f) => /localStorage|sessionStorage|indexedDB|document\.cookie/.test(fs.readFileSync(f, "utf8")));
    expect(offenders, "wake word / mic preference must not be persisted anywhere").toStrictEqual([]);
    const hook = fs.readFileSync(path.join(projectRoot, "hooks/useVoiceConversation.ts"), "utf8");
    expect(hook).toMatch(/enableWakeWord = false/);
    expect(hook).not.toMatch(/getUserMedia/);
  });

  // ---- UI indication ----
  it("indicator: off by default (grey, 'Microphone off', offers Turn on)", () => {
    const html = renderToStaticMarkup(React.createElement(MicStatusIndicator, { enabled: false, active: false, onToggle() {} }));
    expect(html).toMatch(/Microphone off/);
    expect(html).toMatch(/data-mic-active="false"/);
    expect(html).toMatch(/Turn on/);
    expect(html).not.toMatch(/bg-red-500|animate-pulse/);
  });

  it("indicator: enabled but not yet capturing shows a waiting state, not 'listening'", () => {
    const html = renderToStaticMarkup(React.createElement(MicStatusIndicator, { enabled: true, active: false, onToggle() {} }));
    expect(html).toMatch(/Waiting for microphone access/);
    expect(html).toMatch(/data-mic-active="false"/);
    expect(html).not.toMatch(/Microphone ON/);
  });

  it("indicator: actively listening is unmistakable (red pulsing dot, 'Microphone ON', offers Turn off)", () => {
    const html = renderToStaticMarkup(React.createElement(MicStatusIndicator, { enabled: true, active: true, onToggle() {} }));
    expect(html).toMatch(/Microphone ON/);
    expect(html).toMatch(/data-mic-active="true"/);
    expect(html).toMatch(/bg-red-500 animate-pulse/);
    expect(html).toMatch(/Turn off/);
    expect(html).toMatch(/role="status"/);
  });

  it("indicator state follows the hook's real microphone state", async () => {
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
    expect(container.innerHTML).toMatch(/Microphone off/);
    await act(async () => { r.render(React.createElement(Panel, { enabled: true })); });
    expect(container.innerHTML).toMatch(/Waiting for microphone access/);
    await act(async () => { FakeRecognition.instances[0].fireStart(); });
    expect(container.innerHTML).toMatch(/Microphone ON — listening/);
    await act(async () => { r.render(React.createElement(Panel, { enabled: false })); });
    expect(container.innerHTML).toMatch(/Microphone off/);
  });
});
