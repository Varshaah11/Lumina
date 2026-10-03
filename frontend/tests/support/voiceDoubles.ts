/**
 * Test doubles for speech playback: a fake Audio element, object-URL bookkeeping and a controllable /tts fetch.
 * Call installVoiceDoubles() in beforeEach; globals and spies are restored after each test by the Vitest config.
 */
import { vi } from "vitest";

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

export const urls = { created: [] as string[], revoked: [] as string[] };

export interface TtsCall {
  text: string;
  signal: AbortSignal;
  settled: boolean;
  respond(): void;
  fail(status: number): void;
}
/** Every request made to fetch (the /tts endpoint); each one stays pending until the test responds or fails it. */
export const tts = { calls: [] as TtsCall[], url: "" };

function fakeTtsFetch(url: string, init: { body: string; signal?: AbortSignal }) {
  return new Promise<Response>((resolve, reject) => {
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
}

export function installVoiceDoubles() {
  FakeAudio.instances.length = 0;
  urls.created.length = 0;
  urls.revoked.length = 0;
  tts.calls.length = 0;
  tts.url = "";
  let urlCounter = 0;
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("fetch", fakeTtsFetch);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const u = `blob:test/${urlCounter++}`;
    urls.created.push(u);
    return u;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => { urls.revoked.push(u); });
}
