/**
 * Extra test-only shims for the voice hook characterization tests: a controllable clock, a fake Audio element,
 * object-URL bookkeeping and a controllable /tts fetch.
 */
import "./mic_test_support";

const g = globalThis as unknown as Record<string, unknown>;
export const realSetTimeout = globalThis.setTimeout;

type TimerEntry = { at: number; fn: () => void };
export class FakeClock {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, TimerEntry>();
  private realNow = Date.now;
  install() {
    // Each test starts from a clean clock: timers left over from a previous test must never fire in the next one
    this.timers.clear();
    this.now = 0;
    const base = this.realNow.call(Date);
    Date.now = () => base + this.now;
    g.setTimeout = (fn: () => void, ms = 0) => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.now + ms, fn });
      return id;
    };
    g.clearTimeout = (id?: number) => { if (id !== undefined) this.timers.delete(id); };
  }
  uninstall() {
    Date.now = this.realNow;
    g.setTimeout = realSetTimeout;
    g.clearTimeout = clearTimeout;
  }
  pending() { return this.timers.size; }
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; }
      if (nextId === -1) break;
      const t = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = Math.max(this.now, t.at);
      t.fn();
    }
    this.now = target;
  }
}

export class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  volume = 0;
  muted = true;
  currentTime = 0;
  onplay: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  oncanplay: (() => void) | null = null;
  playCalls = 0;
  pauseCalls = 0;
  duration = 1;
  playImpl: () => Promise<void> = () => Promise.resolve();
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play() { this.playCalls++; return this.playImpl(); }
  pause() { this.pauseCalls++; }
  fireEnded() { this.onended?.(); }
  fireError() { this.onerror?.(new Event("error")); }
}
g.Audio = FakeAudio;

export const urls = { created: [] as string[], revoked: [] as string[] };
let urlCounter = 0;
(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => {
  const u = `blob:test/${urlCounter++}`;
  urls.created.push(u);
  return u;
};
(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => { urls.revoked.push(u); };

export interface TtsCall {
  text: string;
  signal: AbortSignal;
  settled: boolean;
  respond(): void;
  fail(status: number): void;
}
export const tts = { calls: [] as TtsCall[], url: "" };
g.fetch = (url: string, init: { body: string; signal?: AbortSignal }) =>
  new Promise<Response>((resolve, reject) => {
    const call: TtsCall = {
      text: JSON.parse(init.body).text,
      signal: init.signal ?? new AbortController().signal,
      settled: false,
      respond() { call.settled = true; resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })); },
      fail(status: number) { call.settled = true; resolve(new Response("err", { status })); },
    };
    tts.url = url;
    init.signal?.addEventListener("abort", () => { call.settled = true; reject(new DOMException("Aborted", "AbortError")); });
    tts.calls.push(call);
  });

export function resetVoiceShims() {
  FakeAudio.instances.length = 0;
  urls.created.length = 0;
  urls.revoked.length = 0;
  tts.calls.length = 0;
  const pushes = g.__routerPushes as unknown[] | undefined;
  if (pushes) pushes.length = 0;
}
