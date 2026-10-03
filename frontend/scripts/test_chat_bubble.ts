/**
 * ChatBubble tests: markup snapshots for every message kind (compared byte-for-byte across refactors when
 * BUBBLE_SNAPSHOT points at a saved snapshot file, otherwise it is written) plus interaction tests for copy,
 * speech playback (backend TTS and the speechSynthesis fallback), regenerate and retry.
 * Run from frontend/:
 *   OUT=$(mktemp -d) && npx tsc -p scripts/tsconfig.test.json --outDir $OUT \
 *     && cp scripts/next_navigation_stub.js $OUT/scripts/ \
 *     && BUBBLE_SNAPSHOT=/tmp/bubble.json NODE_PATH=$PWD/node_modules node $OUT/scripts/test_chat_bubble.js
 */
import "./mic_test_support";
import { FakeAudio, FakeClock, resetVoiceShims, tts, urls } from "./voice_test_support";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthContext } from "../context/AuthContext";
import { ChatBubble } from "../components/chat/ChatBubble";
import type { Message } from "../hooks/useChat";

// Components touch DOM globals (HTMLElement, MouseEvent, ...): expose jsdom's implementations to the Node global scope
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  for (const key of ["Event", "HTMLElement", "Element", "Node", "SVGElement", "DocumentFragment", "MouseEvent", "KeyboardEvent", "FocusEvent",
    "HTMLButtonElement", "HTMLInputElement", "HTMLDivElement", "getComputedStyle", "MutationObserver"]) {
    if (win[key] !== undefined) Object.assign(globalThis, { [key]: win[key] });
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver = g.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
  g.requestAnimationFrame = g.requestAnimationFrame ?? ((cb: () => void) => setTimeout(cb, 0));
  g.cancelAnimationFrame = g.cancelAnimationFrame ?? ((id: number) => clearTimeout(id));
}
const clock = new FakeClock();
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
let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  resetVoiceShims();
  const clip: string[] = [];
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: (t: string) => { clip.push(t); return Promise.resolve(); } }, configurable: true });
  (globalThis as unknown as { __clip: string[] }).__clip = clip;
  const log = console.log; const warn = console.warn; const err = console.error;
  console.warn = () => {}; console.error = () => {};
  clock.install();
  let error: Error | null = null;
  try { await fn(); } catch (e) { error = e as Error; }
  if (root) { try { await act(async () => { root!.unmount(); }); } catch { /* ignore */ } root = null; }
  clock.uninstall();
  console.log = log; console.warn = warn; console.error = err;
  if (error) { failures.push(name); log(`  [FAIL] ${name}\n         ${process.env.BUBBLE_VERBOSE ? String(error.stack).split("\n").slice(0, 6).join("\n         ") : (error.message.split("\n")[0] || String(error))}${(error as unknown as { errors?: Error[] }).errors ? "\n         inner: " + String((error as unknown as { errors: Error[] }).errors[0]?.stack).split("\n").slice(0, 3).join(" | ") : ""}`); }
  else { passed++; log(`  [PASS] ${name}`); }
}
const clipboard = () => (globalThis as unknown as { __clip: string[] }).__clip;

async function render(m: Message, props: { onRegenerate?: () => void; onRetry?: () => void; isStreaming?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(wrap(React.createElement(ChatBubble, { message: m, ...props }))); });
  return container;
}
const byTitle = (c: HTMLElement, title: string) => c.querySelector(`[title="${title}"]`) as HTMLElement | null;
async function click(el: HTMLElement | null) { assert.ok(el, "element exists"); await act(async () => { el!.click(); }); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }

async function main() {
  console.log("\n=== ChatBubble tests ===");
  const snapshotPath = process.env.BUBBLE_SNAPSHOT;
  const current: Record<string, string> = {};
  for (const [name, build] of Object.entries(CASES)) current[name] = build();
  const existing: Record<string, string> | null = snapshotPath && fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, "utf8")) : null;

  // ---------------------------------------------------------------- invariants that must hold regardless of snapshots
  await test("markup: user messages render as plain text (HTML escaped) with the document header chip", () => {
    assert.match(current["user plain"], /Hello &lt;b&gt;there&lt;\/b&gt;/);
    assert.match(current["user with document header"], /📄<\/span><span>report\.pdf<\/span>/);
    assert.match(current["user with document header"], /What does it say\?/);
    assert.match(current["user legacy extracted-text format"], /<span>old\.pdf<\/span>/);
    assert.doesNotMatch(current["user legacy extracted-text format"], /lots of text/);
    assert.match(current["user plain"], /flex-row-reverse/);
    assert.match(current["user plain"], />Sam</);
  });

  await test("markup: empty assistant message shows the three-dot typing indicator and no actions text", () => {
    assert.equal((current["assistant empty shows typing indicator"].match(/animate-bounce/g) || []).length, 3);
    assert.doesNotMatch(current["assistant empty shows typing indicator"], /Speak response/);
  });

  await test("markup: streaming hides the speak button; complete messages show copy + speak; regenerate only when provided", () => {
    assert.doesNotMatch(current["assistant streaming partial"], /title="Speak response"/);
    assert.match(current["assistant complete simple"], /title="Copy message"/);
    assert.match(current["assistant complete simple"], /title="Speak response"/);
    assert.doesNotMatch(current["assistant complete simple"], /Regenerate response/);
    assert.match(current["assistant complete with regenerate"], /title="Regenerate response"/);
  });

  await test("markup: markdown headings get duplicate-safe slug ids and keep their styling", () => {
    const html = current["assistant rich markdown"];
    assert.match(html, /<h1 id="title"/);
    assert.match(html, /<h2 id="section"/);
    assert.match(html, /<h2 id="section-1"/);
    assert.match(html, /<h1 id="title-bold-and-code"/);
    for (const level of [3, 4, 5, 6]) assert.match(html, new RegExp(`<h${level} id=`));
    assert.match(html, /scroll-mt-4/);
  });

  await test("markup: lists, task list, blockquote, table, hr, strikethrough, inline code and math", () => {
    const html = current["assistant rich markdown"];
    assert.match(html, /<ul class="list-disc/);
    assert.match(html, /<ol class="list-decimal/);
    assert.match(html, /<input[^>]*type="checkbox"[^>]*disabled/);
    assert.match(html, /<blockquote class="border-l-4/);
    assert.match(html, /<table class="w-full/);
    assert.match(html, /<hr class="my-6/);
    assert.match(html, /<del class="line-through/);
    assert.match(html, /<code class="bg-white\/10 px-1\.5/);
    assert.match(html, /class="katex"/);
  });

  await test("markup: external links open in a new tab safely; internal and mailto links do not; javascript: links are neutralised", () => {
    const html = current["assistant rich markdown"];
    assert.match(html, /<a href="https:\/\/example\.com\/page" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /<a href="#section"[^>]*>/);
    assert.doesNotMatch(html.match(/<a href="#section"[^>]*>/)![0], /target=/);
    assert.doesNotMatch(html, /href="javascript:/i);
  });

  await test("markup: fenced code gets a header with the language and a copy button; unlabeled multi-line blocks say 'code'", () => {
    const html = current["assistant rich markdown"];
    assert.match(html, /uppercase tracking-wider">js<\/span>/);
    assert.match(html, /uppercase tracking-wider">python<\/span>/);
    assert.match(html, /uppercase tracking-wider">code<\/span>/);
    assert.ok((html.match(/title="Copy code"/g) || []).length >= 3);
    assert.match(html, /const/);
  });

  await test("markup: raw HTML in Markdown stays inert text; images are rendered by react-markdown, scripts never", () => {
    const html = current["assistant rich markdown"];
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /&lt;script&gt;alert/);
    assert.doesNotMatch(current["error with markup characters"], /<img src=x/);
    assert.match(current["error with markup characters"], /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quotes&quot;/);
  });

  await test("markup: citations/sources stay readable text", () => {
    assert.match(current["assistant rich markdown"], /\[Source: report\.pdf, Page 3\]/);
    assert.match(current["assistant rich markdown"], /\[Source: notes\.txt\]/);
  });

  await test("markup: mermaid fences are handed to the diagram component (not shown as a code block)", () => {
    const html = current["assistant rich markdown"];
    assert.doesNotMatch(html, /uppercase tracking-wider">mermaid<\/span>/);
  });

  await test("markup: unterminated code fence while streaming renders as a code block without crashing", () => {
    assert.match(current["assistant unterminated code fence while streaming"].replace(/<[^>]+>/g, ""), /const a = 1;/);
  });

  await test("markup: errors show the system-error styling, a retry button only when provided, and a copy button", () => {
    assert.match(current["error without retry"], /System Error/);
    assert.doesNotMatch(current["error without retry"], /Retry failed request/);
    assert.match(current["error with retry"], /title="Retry failed request"/);
    assert.match(current["error with retry"], /title="Copy error message"/);
  });

  await test("markup snapshots are identical to the saved baseline", () => {
    if (!existing) { fs.writeFileSync(snapshotPath ?? "/dev/null", JSON.stringify(current, null, 1)); return; }
    assert.deepEqual(Object.keys(current), Object.keys(existing));
    for (const name of Object.keys(existing)) assert.equal(current[name], existing[name], `snapshot differs: ${name}`);
  });

  // ---------------------------------------------------------------- interactions
  await test("copy message: writes the raw content to the clipboard and shows the check icon for 2 seconds", async () => {
    const c = await render(msg("assistant", "Some **markdown** answer"));
    const button = byTitle(c, "Copy message")!;
    assert.ok(button.querySelector("svg.lucide-copy"));
    await click(button);
    assert.deepEqual(clipboard(), ["Some **markdown** answer"]);
    assert.ok(byTitle(c, "Copy message")!.querySelector("svg.lucide-check"));
    await act(async () => { clock.advance(2000); });
    assert.ok(byTitle(c, "Copy message")!.querySelector("svg.lucide-copy"));
  });

  await test("copy error message uses the error copy button", async () => {
    const c = await render(msg("error", "It broke"), { onRetry: () => {} });
    await click(byTitle(c, "Copy error message"));
    assert.deepEqual(clipboard(), ["It broke"]);
  });

  await test("copy code: copies exactly the code text (without the trailing newline)", async () => {
    const c = await render(msg("assistant", "```js\nconst x = 1;\nconsole.log(x);\n```"));
    await click(byTitle(c, "Copy code"));
    assert.deepEqual(clipboard(), ["const x = 1;\nconsole.log(x);"]);
  });

  await test("regenerate and retry buttons call their handlers", async () => {
    let regen = 0, retry = 0;
    const a = await render(msg("assistant", "answer"), { onRegenerate: () => { regen++; } });
    await click(byTitle(a, "Regenerate response"));
    assert.equal(regen, 1);
    await act(async () => { root!.unmount(); }); root = null;
    const e = await render(msg("error", "failed"), { onRetry: () => { retry++; } });
    await click(byTitle(e, "Retry failed request"));
    assert.equal(retry, 1);
  });

  await test("speak: requests the sanitized text from /tts, shows 'Stop speaking' while pending/speaking, plays audio", async () => {
    const c = await render(msg("assistant", "**Hello** there, this is `code` and a [link](https://x.y)."));
    await click(byTitle(c, "Speak response"));
    await flush();
    assert.equal(tts.calls.length, 1);
    assert.equal(tts.calls[0].text, "Hello there, this is code and a link.");
    assert.ok(byTitle(c, "Stop speaking"), "pending state shows the stop button");
    tts.calls[0].respond();
    await flush(); await flush();
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(FakeAudio.instances[0].playCalls, 1);
    await act(async () => { FakeAudio.instances[0].onplay?.(); });
    assert.ok(byTitle(c, "Stop speaking"));
    await act(async () => { FakeAudio.instances[0].fireEnded(); });
    assert.ok(byTitle(c, "Speak response"), "back to idle when playback ends");
    assert.ok(urls.revoked.includes(FakeAudio.instances[0].src));
  });

  await test("speak: clicking stop aborts the request / pauses audio and returns to idle", async () => {
    const c = await render(msg("assistant", "Rivers carry water to the sea."));
    await click(byTitle(c, "Speak response"));
    await flush();
    const call = tts.calls[0];
    await click(byTitle(c, "Stop speaking"));
    await flush();
    assert.ok(call.signal.aborted);
    assert.ok(byTitle(c, "Speak response"));
    assert.equal(FakeAudio.instances.length, 0);
  });

  await test("speak: only one message speaks at a time (starting another stops the first)", async () => {
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
    assert.ok(firstCall.signal.aborted, "first request cancelled");
    assert.ok(byTitle(first, "Speak response"), "first bubble back to idle");
    assert.equal(tts.calls.length, 2);
    await act(async () => { root2.unmount(); });
  });

  await test("speak: backend failure falls back to the browser speechSynthesis voice", async () => {
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
      assert.deepEqual(spoken, ["Rivers carry water to the sea."]);
      assert.ok(byTitle(c, "Stop speaking"), "shows speaking state during the fallback");
    } finally {
      delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
      delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
      delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    }
  });

  await test("speak: unmounting a speaking bubble stops its speech", async () => {
    const c = await render(msg("assistant", "Rivers carry water to the sea."));
    await click(byTitle(c, "Speak response"));
    await flush();
    const call = tts.calls[0];
    await act(async () => { root!.unmount(); }); root = null;
    assert.ok(call.signal.aborted);
  });

  await test("speak: a message with only markdown symbols (nothing speakable) does nothing", async () => {
    const c = await render(msg("assistant", "---"));
    await click(byTitle(c, "Speak response"));
    await flush();
    assert.equal(tts.calls.length, 0);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main();
