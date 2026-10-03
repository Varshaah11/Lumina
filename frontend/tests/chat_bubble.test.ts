/**
 * ChatBubble tests: markup snapshots for every message kind (stored in __snapshots__/chat_bubble.test.ts.snap and
 * compared byte-for-byte) plus interaction tests for copy, speech playback (backend TTS and the speechSynthesis
 * fallback), regenerate and retry. Migrated 1:1 from the former custom harness scripts/test_chat_bubble.ts (23 checks).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { AuthContext } from "@/context/AuthContext";
import type { Message } from "@/hooks/useChat";
import { installFakeClock } from "./support/fakeClock";
import { FakeAudio, installVoiceDoubles, tts, urls } from "./support/voiceDoubles";

const authValue = {
  user: { id: 1, email: "sam@example.com", name: "Sam" },
  isAuthenticated: true, isLoading: false,
  login: async () => {}, register: async () => {}, logout: async () => {}, updateUser: () => {}, refreshUser: async () => {},
};
const msg = (role: Message["role"], content: string, extra: Partial<Message> = {}): Message =>
  ({ id: "m1", role, content, timestamp: new Date(2026, 0, 15, 9, 30), ...extra });
const wrap = (el: React.ReactElement) => React.createElement(AuthContext.Provider, { value: authValue }, el);
const markup = (m: Message, props: { onRegenerate?: () => void; onRetry?: () => void; isStreaming?: boolean } = {}) =>
  renderToStaticMarkup(wrap(React.createElement(ChatBubble, { message: m, ...props })));

const RICH = [
  "# Title", "## Section", "### Sub", "#### Four", "##### Five", "###### Six",
  "## Section", "# Title ***bold*** and `code`",
  "", "Paragraph with **bold**, *italic*, ~~strike~~, `inline code` and a [link](https://example.com/page).",
  "Internal [anchor](#section) and [relative](/docs) and [bad](javascript:alert(1)) and [mail](mailto:a@b.c).",
  "", "- bullet one", "- bullet two", "  - nested", "", "1. first", "2. second", "",
  "- [x] done task", "- [ ] open task", "",
  "> quoted *text*", "",
  "| Name | Value |", "|------|-------|", "| a | 1 |", "| b | 2 |", "",
  "---", "",
  "```js", "const x = 1;", "console.log(x);", "```", "",
  "```", "plain block", "second line", "```", "",
  "```python", "print('hi')", "```", "",
  "```mermaid", "graph LR", "A[\"Start\"] --> B[\"End\"]", "```", "",
  "Inline math $a^2 + b^2 = c^2$ and block:", "", "$$", "\\frac{1}{2}", "$$", "",
  "Citation: [Source: report.pdf, Page 3] and [Source: notes.txt]", "",
  "<script>alert('x')</script> and <b>html</b> stay text", "",
  "![img](https://example.com/a.png)",
].join("\n");

const CASES: Record<string, () => string> = {
  "user plain": () => markup(msg("user", "Hello <b>there</b>\nsecond line")),
  "user with document header": () => markup(msg("user", "📄 report.pdf\n\nWhat does it say?")),
  "user document header without prompt": () => markup(msg("user", "📄 report.pdf")),
  "user legacy extracted-text format": () => markup(msg("user", '[Attached Document: old.pdf]\nExtracted Content:\n"""\nlots of text\n"""\nSummarize it')),
  "user empty": () => markup(msg("user", "")),
  "user voice": () => markup(msg("user", "spoken", { isVoice: true })),
  "assistant empty shows typing indicator": () => markup(msg("assistant", ""), { isStreaming: true }),
  "assistant streaming partial": () => markup(msg("assistant", "Rivers carry wat"), { isStreaming: true }),
  "assistant complete simple": () => markup(msg("assistant", "Paris is the capital of France.")),
  "assistant complete with regenerate": () => markup(msg("assistant", "Paris is the capital of France."), { onRegenerate: () => {} }),
  "assistant whitespace only": () => markup(msg("assistant", "   ")),
  "assistant rich markdown": () => markup(msg("assistant", RICH)),
  "assistant rich markdown streaming": () => markup(msg("assistant", RICH), { isStreaming: true, onRegenerate: () => {} }),
  "assistant unterminated code fence while streaming": () => markup(msg("assistant", "Here:\n```js\nconst a = 1;"), { isStreaming: true }),
  "error without retry": () => markup(msg("error", "Lumina couldn't connect. Please try again later.")),
  "error with retry": () => markup(msg("error", "Lumina couldn't connect."), { onRetry: () => {} }),
  "error with markup characters": () => markup(msg("error", "<img src=x onerror=alert(1)> & \"quotes\"")),
};

let root: Root | null = null;
let clip: string[] = [];
const clipboard = () => clip;
const current: Record<string, string> = {};

async function render(m: Message, props: { onRegenerate?: () => void; onRetry?: () => void; isStreaming?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(wrap(React.createElement(ChatBubble, { message: m, ...props }))); });
  return container;
}
const byTitle = (c: HTMLElement, title: string) => c.querySelector(`[title="${title}"]`) as HTMLElement | null;
async function click(el: HTMLElement | null) { expect(el, "element exists").toBeTruthy(); await act(async () => { el!.click(); }); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }

beforeAll(() => {
  for (const [name, build] of Object.entries(CASES)) current[name] = build();
});

beforeEach(() => {
  installVoiceDoubles();
  clip = [];
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: (t: string) => { clip.push(t); return Promise.resolve(); } }, configurable: true });
  // As in the original harness: no layout observers, and animation frames run on the (fake) timer queue
  if (typeof ResizeObserver === "undefined") vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  installFakeClock();
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
});

describe("ChatBubble", () => {

  it("markup: user messages render as plain text (HTML escaped) with the document header chip", () => {
    expect(current["user plain"]).toMatch(/Hello &lt;b&gt;there&lt;\/b&gt;/);
    expect(current["user with document header"]).toMatch(/📄<\/span><span>report\.pdf<\/span>/);
    expect(current["user with document header"]).toMatch(/What does it say\?/);
    expect(current["user legacy extracted-text format"]).toMatch(/<span>old\.pdf<\/span>/);
    expect(current["user legacy extracted-text format"]).not.toMatch(/lots of text/);
    expect(current["user plain"]).toMatch(/flex-row-reverse/);
    expect(current["user plain"]).toMatch(/>Sam</);
  });

  it("markup: empty assistant message shows the three-dot typing indicator and no actions text", () => {
    expect((current["assistant empty shows typing indicator"].match(/animate-bounce/g) || []).length).toBe(3);
    expect(current["assistant empty shows typing indicator"]).not.toMatch(/Speak response/);
  });

  it("markup: streaming hides the speak button; complete messages show copy + speak; regenerate only when provided", () => {
    expect(current["assistant streaming partial"]).not.toMatch(/title="Speak response"/);
    expect(current["assistant complete simple"]).toMatch(/title="Copy message"/);
    expect(current["assistant complete simple"]).toMatch(/title="Speak response"/);
    expect(current["assistant complete simple"]).not.toMatch(/Regenerate response/);
    expect(current["assistant complete with regenerate"]).toMatch(/title="Regenerate response"/);
  });

  it("markup: markdown headings get duplicate-safe slug ids and keep their styling", () => {
    const html = current["assistant rich markdown"];
    expect(html).toMatch(/<h1 id="title"/);
    expect(html).toMatch(/<h2 id="section"/);
    expect(html).toMatch(/<h2 id="section-1"/);
    expect(html).toMatch(/<h1 id="title-bold-and-code"/);
    for (const level of [3, 4, 5, 6]) expect(html).toMatch(new RegExp(`<h${level} id=`));
    expect(html).toMatch(/scroll-mt-4/);
  });

  it("markup: lists, task list, blockquote, table, hr, strikethrough, inline code and math", () => {
    const html = current["assistant rich markdown"];
    expect(html).toMatch(/<ul class="list-disc/);
    expect(html).toMatch(/<ol class="list-decimal/);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
    expect(html).toMatch(/<blockquote class="border-l-4/);
    expect(html).toMatch(/<table class="w-full/);
    expect(html).toMatch(/<hr class="my-6/);
    expect(html).toMatch(/<del class="line-through/);
    expect(html).toMatch(/<code class="bg-white\/10 px-1\.5/);
    expect(html).toMatch(/class="katex"/);
  });

  it("markup: external links open in a new tab safely; internal and mailto links do not; javascript: links are neutralised", () => {
    const html = current["assistant rich markdown"];
    expect(html).toMatch(/<a href="https:\/\/example\.com\/page" target="_blank" rel="noopener noreferrer"/);
    expect(html).toMatch(/<a href="#section"[^>]*>/);
    expect(html.match(/<a href="#section"[^>]*>/)![0]).not.toMatch(/target=/);
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("markup: fenced code gets a header with the language and a copy button; unlabeled multi-line blocks say 'code'", () => {
    const html = current["assistant rich markdown"];
    expect(html).toMatch(/uppercase tracking-wider">js<\/span>/);
    expect(html).toMatch(/uppercase tracking-wider">python<\/span>/);
    expect(html).toMatch(/uppercase tracking-wider">code<\/span>/);
    expect((html.match(/title="Copy code"/g) || []).length >= 3).toBeTruthy();
    expect(html).toMatch(/const/);
  });

  it("markup: raw HTML in Markdown stays inert text; images are rendered by react-markdown, scripts never", () => {
    const html = current["assistant rich markdown"];
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/&lt;script&gt;alert/);
    expect(current["error with markup characters"]).not.toMatch(/<img src=x/);
    expect(current["error with markup characters"]).toMatch(/&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quotes&quot;/);
  });

  it("markup: citations/sources stay readable text", () => {
    expect(current["assistant rich markdown"]).toMatch(/\[Source: report\.pdf, Page 3\]/);
    expect(current["assistant rich markdown"]).toMatch(/\[Source: notes\.txt\]/);
  });

  it("markup: mermaid fences are handed to the diagram component (not shown as a code block)", () => {
    const html = current["assistant rich markdown"];
    expect(html).not.toMatch(/uppercase tracking-wider">mermaid<\/span>/);
  });

  it("markup: unterminated code fence while streaming renders as a code block without crashing", () => {
    expect(current["assistant unterminated code fence while streaming"].replace(/<[^>]+>/g, "")).toMatch(/const a = 1;/);
  });

  it("markup: errors show the system-error styling, a retry button only when provided, and a copy button", () => {
    expect(current["error without retry"]).toMatch(/System Error/);
    expect(current["error without retry"]).not.toMatch(/Retry failed request/);
    expect(current["error with retry"]).toMatch(/title="Retry failed request"/);
    expect(current["error with retry"]).toMatch(/title="Copy error message"/);
  });

  it("markup snapshots are identical to the saved baseline", () => {
    expect(Object.keys(current)).toStrictEqual(Object.keys(CASES));
    for (const name of Object.keys(CASES)) expect(current[name]).toMatchSnapshot(name);
  });

  // ---------------------------------------------------------------- interactions
  it("copy message: writes the raw content to the clipboard and shows the check icon for 2 seconds", async () => {
    const c = await render(msg("assistant", "Some **markdown** answer"));
    const button = byTitle(c, "Copy message")!;
    expect(button.querySelector("svg.lucide-copy")).toBeTruthy();
    await click(button);
    expect(clipboard()).toStrictEqual(["Some **markdown** answer"]);
    expect(byTitle(c, "Copy message")!.querySelector("svg.lucide-check")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(byTitle(c, "Copy message")!.querySelector("svg.lucide-copy")).toBeTruthy();
  });

  it("copy error message uses the error copy button", async () => {
    const c = await render(msg("error", "It broke"), { onRetry: () => {} });
    await click(byTitle(c, "Copy error message"));
    expect(clipboard()).toStrictEqual(["It broke"]);
  });

  it("copy code: copies exactly the code text (without the trailing newline)", async () => {
    const c = await render(msg("assistant", "```js\nconst x = 1;\nconsole.log(x);\n```"));
    await click(byTitle(c, "Copy code"));
    expect(clipboard()).toStrictEqual(["const x = 1;\nconsole.log(x);"]);
  });

  it("regenerate and retry buttons call their handlers", async () => {
    let regen = 0, retry = 0;
    const a = await render(msg("assistant", "answer"), { onRegenerate: () => { regen++; } });
    await click(byTitle(a, "Regenerate response"));
    expect(regen).toBe(1);
    await act(async () => { root!.unmount(); }); root = null;
    const e = await render(msg("error", "failed"), { onRetry: () => { retry++; } });
    await click(byTitle(e, "Retry failed request"));
    expect(retry).toBe(1);
  });

  it("speak: requests the sanitized text from /tts, shows 'Stop speaking' while pending/speaking, plays audio", async () => {
    const c = await render(msg("assistant", "**Hello** there, this is `code` and a [link](https://x.y)."));
    await click(byTitle(c, "Speak response"));
    await flush();
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0].text).toBe("Hello there, this is code and a link.");
    expect(byTitle(c, "Stop speaking"), "pending state shows the stop button").toBeTruthy();
    tts.calls[0].respond();
    await flush(); await flush();
    expect(FakeAudio.instances.length).toBe(1);
    expect(FakeAudio.instances[0].playCalls).toBe(1);
    await act(async () => { FakeAudio.instances[0].onplay?.(); });
    expect(byTitle(c, "Stop speaking")).toBeTruthy();
    await act(async () => { FakeAudio.instances[0].fireEnded(); });
    expect(byTitle(c, "Speak response"), "back to idle when playback ends").toBeTruthy();
    expect(urls.revoked.includes(FakeAudio.instances[0].src)).toBeTruthy();
  });

  it("speak: clicking stop aborts the request / pauses audio and returns to idle", async () => {
    const c = await render(msg("assistant", "Rivers carry water to the sea."));
    await click(byTitle(c, "Speak response"));
    await flush();
    const call = tts.calls[0];
    await click(byTitle(c, "Stop speaking"));
    await flush();
    expect(call.signal.aborted).toBeTruthy();
    expect(byTitle(c, "Speak response")).toBeTruthy();
    expect(FakeAudio.instances.length).toBe(0);
  });

  it("speak: only one message speaks at a time (starting another stops the first)", async () => {
    const first = await render(msg("assistant", "First answer about rivers."));
    await click(byTitle(first, "Speak response"));
    await flush();
    const firstCall = tts.calls[0];
    const second = document.createElement("div");
    document.body.appendChild(second);
    const root2 = createRoot(second);
    await act(async () => { root2.render(wrap(React.createElement(ChatBubble, { message: msg("assistant", "Second answer about lakes.", { id: "m2" }) }))); });
    await click(byTitle(second, "Speak response"));
    await flush();
    expect(firstCall.signal.aborted, "first request cancelled").toBeTruthy();
    expect(byTitle(first, "Speak response"), "first bubble back to idle").toBeTruthy();
    expect(tts.calls.length).toBe(2);
    await act(async () => { root2.unmount(); });
  });

  it("speak: backend failure falls back to the browser speechSynthesis voice", async () => {
    const spoken: string[] = [];
    class Utterance { text: string; rate = 1; pitch = 1; volume = 1; lang = ""; voice: unknown = null; onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor(t: string) { this.text = t; } }
    const synth = { speak: (u: Utterance) => { spoken.push(u.text); u.onstart?.(); }, cancel: () => {}, getVoices: () => [] as unknown[], onvoiceschanged: null as unknown };
    Object.assign(window, { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance });
    Object.assign(globalThis, { SpeechSynthesisUtterance: Utterance });
    try {
      const c = await render(msg("assistant", "Rivers carry water to the sea."));
      await click(byTitle(c, "Speak response"));
      await flush();
      tts.calls[0].fail(503);
      await flush(); await flush();
      expect(spoken).toStrictEqual(["Rivers carry water to the sea."]);
      expect(byTitle(c, "Stop speaking"), "shows speaking state during the fallback").toBeTruthy();
    } finally {
      delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
      delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
      delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    }
  });

  it("speak: unmounting a speaking bubble stops its speech", async () => {
    const c = await render(msg("assistant", "Rivers carry water to the sea."));
    await click(byTitle(c, "Speak response"));
    await flush();
    const call = tts.calls[0];
    await act(async () => { root!.unmount(); }); root = null;
    expect(call.signal.aborted).toBeTruthy();
  });

  it("speak: a message with only markdown symbols (nothing speakable) does nothing", async () => {
    const c = await render(msg("assistant", "---"));
    await click(byTitle(c, "Speak response"));
    await flush();
    expect(tts.calls.length).toBe(0);
  });
});
