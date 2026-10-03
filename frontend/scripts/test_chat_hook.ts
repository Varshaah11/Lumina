/**
 * Behavior (characterization) tests for useChat: send, document-backed send, streaming, stop/abort, errors, retry,
 * regenerate, chat-id/URL/sidebar updates. chatService is replaced by a controllable fake; assertions are on observable
 * behavior only (messages, isLoading, requests made, events dispatched), so they hold across internal refactors.
 * Run from frontend/:
 *   OUT=$(mktemp -d) && npx tsc -p scripts/tsconfig.test.json --outDir $OUT \
 *     && cp scripts/next_navigation_stub.js $OUT/scripts/ && NODE_PATH=$PWD/node_modules node $OUT/scripts/test_chat_hook.js
 */
import "./mic_test_support";
// The hook creates DOM events with the global Event; make it the jsdom one so window.dispatchEvent accepts it
Object.assign(globalThis, { Event: (globalThis as unknown as { window: { Event: unknown } }).window.Event });
import { FakeClock } from "./voice_test_support";
import assert from "node:assert/strict";
import React, { act, useEffect, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { useChat } from "../hooks/useChat";
import { chatService, type UploadFileResponse } from "../services/chat";
import type { ChatDetail } from "../types/api";

type Chat = ReturnType<typeof useChat>;
const clock = new FakeClock();

interface StreamCall {
  message: string;
  chatId: string | null;
  isVoice?: boolean;
  documentId?: number | null;
  onChunk(t: string): void;
  onChatId(id: string): void;
  onError(e: string): void;
  onComplete(): void;
  controller: AbortController;
}
interface RegenCall {
  chatId: string;
  isVoice: boolean;
  onChunk(t: string): void;
  onError(e: string): void;
  onComplete(): void;
  controller: AbortController;
}
const streams: StreamCall[] = [];
const regens: RegenCall[] = [];
const uploads: { name: string; chatId?: string | null; aborted: () => boolean }[] = [];
let uploadImpl: (file: File) => Promise<UploadFileResponse> = async (f) => ({ id: 7, filename: f.name, file_type: "pdf", character_count: 10, chunk_count: 1 });
let historyImpl: (id: string) => Promise<ChatDetail> = async (id) => ({ id: Number(id), title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00", messages: [] });
const historyCalls: string[] = [];

function emulateAbort(controller: AbortController, onComplete: () => void) {
  // The real SSE helper reports an aborted stream through onComplete (AbortError path)
  controller.signal.addEventListener("abort", () => { Promise.resolve().then(onComplete); });
}
chatService.streamMessage = (message, chatId, onChunk, onChatId, onError, onComplete, isVoice, documentId) => {
  const controller = new AbortController();
  emulateAbort(controller, onComplete);
  streams.push({ message, chatId, isVoice, documentId, onChunk, onChatId, onError, onComplete, controller });
  return controller;
};
chatService.regenerateMessage = (chatId, onChunk, onError, onComplete, isVoice = false) => {
  const controller = new AbortController();
  emulateAbort(controller, onComplete);
  regens.push({ chatId, isVoice, onChunk, onError, onComplete, controller });
  return controller;
};
chatService.uploadFile = async (file, signal, chatId) => {
  uploads.push({ name: file.name, chatId, aborted: () => !!signal?.aborted });
  return uploadImpl(file);
};
chatService.getChatHistory = async (id) => { historyCalls.push(id); return historyImpl(id); };

let root: Root | null = null;
let chat: Chat;
function Harness() {
  const [, rerender] = useState(0);
  // Next re-renders consumers of useSearchParams when the URL changes (the hook rewrites it with history.replaceState)
  useEffect(() => {
    const onUrlChange = () => rerender((n) => n + 1);
    window.addEventListener("chat-created", onUrlChange);
    return () => window.removeEventListener("chat-created", onUrlChange);
  }, []);
  const current = useChat();
  useEffect(() => { chat = current; });
  return null;
}
const events: string[] = [];
const warns: string[] = [];
const replaced: string[] = [];
const onEvent = (e: Event) => { events.push(e.type); };
const origReplace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => { replaced.push(String(url)); origReplace(data, unused, url); };

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
async function mount(searchParams: Record<string, string> = {}) {
  origReplace(null, "", Object.keys(searchParams).length ? `/chat?${new URLSearchParams(searchParams).toString()}` : "/chat");
  root = createRoot(document.createElement("div"));
  await act(async () => { root!.render(React.createElement(Harness)); });
  await flush();
}
async function unmount() { if (root) { await act(async () => { root!.unmount(); }); root = null; } }
const roles = () => chat.messages.map((m) => m.role);
const contents = () => chat.messages.map((m) => m.content);
const file = (name = "doc.pdf") => new File(["x"], name);

let passed = 0;
const failures: string[] = [];
const results: Record<string, "PASS" | "FAIL"> = {};
async function test(name: string, fn: () => Promise<void>) {
  streams.length = 0; regens.length = 0; uploads.length = 0; historyCalls.length = 0; events.length = 0; replaced.length = 0;
  uploadImpl = async (f) => ({ id: 7, filename: f.name, file_type: "pdf", character_count: 10, chunk_count: 1 });
  historyImpl = async (id) => ({ id: Number(id), title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00", messages: [] });
  warns.length = 0;
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  clock.install();
  for (const t of ["chat-created", "chats-updated"]) window.addEventListener(t, onEvent);
  let error: Error | null = null;
  try { await fn(); } catch (e) { error = e as Error; }
  try { await unmount(); } catch { /* ignore */ }
  for (const t of ["chat-created", "chats-updated"]) window.removeEventListener(t, onEvent);
  clock.uninstall();
  console.log = log; console.warn = warn;
  if (error) { failures.push(name); results[name] = "FAIL"; log(`  [FAIL] ${name}\n         ${process.env.CHAT_TEST_VERBOSE ? error.message.split("\n").slice(0, 8).join("\n         ") : error.message.split("\n")[0]}`); }
  else { passed++; results[name] = "PASS"; log(`  [PASS] ${name}`); }
}

async function main() {
  console.log("\n=== useChat behavior tests ===");

  // ------------------------------------------------------------------ sendMessage
  await test("send: new chat adds user + empty assistant message, streams, accumulates tokens", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("  hello there  "); });
    assert.deepEqual(roles(), ["user", "assistant"]);
    assert.deepEqual(contents(), ["hello there", ""]);
    assert.equal(chat.isLoading, true);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].message, "hello there");
    assert.equal(streams[0].chatId, null);
    assert.equal(streams[0].documentId, null);
    assert.ok(!streams[0].isVoice);
    await act(async () => { streams[0].onChunk("Hel"); streams[0].onChunk("lo"); streams[0].onChunk(" world"); });
    assert.equal(chat.messages[1].content, "Hello world");
    assert.equal(chat.messages[0].content, "hello there");
  });

  await test("send: ids are unique and timestamps set", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    const ids = chat.messages.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(chat.messages.every((m) => m.timestamp instanceof Date));
  });

  await test("send: new chat id event updates URL, sidebar events fire on completion, titles refresh later", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hello"); });
    await act(async () => { streams[0].onChatId("42"); });
    assert.deepEqual(replaced, [], "URL is not rewritten until the stream ends");
    await act(async () => { streams[0].onChunk("ok"); streams[0].onComplete(); });
    assert.equal(chat.isLoading, false);
    assert.deepEqual(replaced, ["/chat?chatId=42"]);
    assert.deepEqual(events, ["chat-created"]);
    await act(async () => { clock.advance(5000); });
    assert.deepEqual(events, ["chat-created", "chats-updated"]);
    await act(async () => { clock.advance(10000); });
    assert.deepEqual(events, ["chat-created", "chats-updated", "chats-updated"]);
  });

  await test("send: the second message in the same chat uses the chat id and does not rewrite the URL", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hello"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onChunk("ok"); streams[0].onComplete(); });
    replaced.length = 0; events.length = 0;
    await act(async () => { await chat.sendMessage("and again"); });
    assert.equal(streams[1].chatId, "42");
    await act(async () => { streams[1].onChunk("sure"); streams[1].onComplete(); });
    assert.equal(chat.isLoading, false);
    assert.deepEqual(roles(), ["user", "assistant", "user", "assistant"]);
    assert.deepEqual(replaced, [], "URL rewritten once per new chat");
  });

  await test("send: existing chat from the URL loads history and sends with that chat id (no URL rewrite)", async () => {
    historyImpl = async () => ({ id: 5, title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
      messages: [{ id: 1, role: "user", content: "old q", created_at: "2026-01-01T00:00:00" }, { id: 2, role: "assistant", content: "old a", created_at: "2026-01-01T00:00:01" }] });
    await mount({ chatId: "5" });
    assert.deepEqual(historyCalls, ["5"]);
    assert.deepEqual(contents(), ["old q", "old a"]);
    assert.equal(chat.isLoading, false);
    await act(async () => { await chat.sendMessage("follow up"); });
    assert.equal(streams[0].chatId, "5");
    await act(async () => { streams[0].onChunk("ok"); streams[0].onComplete(); });
    assert.deepEqual(replaced, []);
    assert.deepEqual(events, []);
    assert.deepEqual(contents(), ["old q", "old a", "follow up", "ok"]);
  });

  await test("send: empty text, whitespace and a send while loading are ignored", async () => {
    await mount();
    await act(async () => { await chat.sendMessage(""); await chat.sendMessage("   "); });
    assert.equal(streams.length, 0);
    await act(async () => { await chat.sendMessage("first"); });
    await act(async () => { await chat.sendMessage("second while loading"); });
    assert.equal(streams.length, 1);
    assert.equal(chat.messages.length, 2);
  });

  await test("send: voice messages are flagged and the flag reaches the request", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("spoken question", null, true); });
    assert.equal(streams[0].isVoice, true);
    assert.equal(chat.messages[0].isVoice, true);
    assert.equal(chat.messages[1].isVoice, true);
  });

  await test("send with document: uploads first, shows the file header, sends documentId and visible content", async () => {
    await mount();
    await act(async () => { const p = chat.sendMessage("what is this?", file("report.pdf")); await p; });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].name, "report.pdf");
    assert.equal(uploads[0].chatId, null);
    assert.equal(streams[0].message, "📄 report.pdf\n\nwhat is this?");
    assert.equal(streams[0].documentId, 7);
    assert.equal(chat.messages[0].content, "📄 report.pdf\n\nwhat is this?");
    assert.equal(chat.isUploading, false);
  });

  await test("send with document and no text uses the default analysis prompt", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("", file("report.pdf")); });
    assert.equal(streams[0].message, "📄 report.pdf\n\nPlease analyze and summarize the contents of this document.");
  });

  await test("send with document: upload progress state and chat id passed to the upload", async () => {
    await mount({ chatId: "9" });
    let release: (r: UploadFileResponse) => void = () => {};
    uploadImpl = () => new Promise((res) => { release = res; });
    let sending: Promise<void> | undefined;
    await act(async () => { sending = chat.sendMessage("q", file("a.pdf")); });
    assert.equal(chat.isUploading, true);
    assert.equal(chat.isLoading, true);
    assert.equal(streams.length, 0);
    assert.equal(uploads[0].chatId, "9");
    await act(async () => { release({ id: 3, filename: "a.pdf", file_type: "pdf", character_count: 1, chunk_count: 1 }); await sending; });
    assert.equal(chat.isUploading, false);
    assert.equal(streams[0].documentId, 3);
    assert.equal(streams[0].chatId, "9");
  });

  await test("upload failure: error bubble, loading cleared, no stream", async () => {
    uploadImpl = async () => { throw new Error("File is too large (maximum 10 MB)"); };
    await mount();
    await act(async () => { await chat.sendMessage("q", file()); });
    assert.deepEqual(roles(), ["error"]);
    assert.equal(chat.messages[0].content, "File is too large (maximum 10 MB)");
    assert.equal(chat.isLoading, false);
    assert.equal(chat.isUploading, false);
    assert.equal(streams.length, 0);
  });

  await test("upload aborted by stop: no error bubble, no stream", async () => {
    await mount();
    let reject: (e: Error) => void = () => {};
    uploadImpl = () => new Promise((_res, rej) => { reject = rej; });
    let sending: Promise<void> | undefined;
    await act(async () => { sending = chat.sendMessage("q", file()); });
    await act(async () => { chat.stopGeneration(); });
    const abort = new Error("aborted"); abort.name = "AbortError";
    await act(async () => { reject(abort); await sending; });
    assert.equal(chat.messages.length, 0);
    assert.equal(chat.isLoading, false);
    assert.equal(streams.length, 0);
  });

  // ------------------------------------------------------------------ stop / abort / errors
  await test("stop: aborts the stream, clears loading, keeps the partial reply and does not record a retry", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("tell me"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onChunk("partial answ"); });
    await act(async () => { chat.stopGeneration(); });
    await flush();
    assert.ok(streams[0].controller.signal.aborted);
    assert.equal(chat.isLoading, false);
    assert.equal(chat.messages[1].content, "partial answ");
    assert.deepEqual(roles(), ["user", "assistant"]);
  });

  await test("stop with nothing running is a no-op", async () => {
    await mount();
    await act(async () => { chat.stopGeneration(); });
    assert.equal(chat.isLoading, false);
    assert.equal(chat.messages.length, 0);
  });

  await test("stream error: empty placeholder replaced by one error bubble, loading cleared", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("Lumina couldn't connect. Please try again later."); });
    assert.deepEqual(roles(), ["user", "error"]);
    assert.equal(chat.messages[1].content, "Lumina couldn't connect. Please try again later.");
    assert.equal(chat.isLoading, false);
  });

  await test("stream error after partial text keeps the partial reply and adds the error", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onChunk("half"); streams[0].onError("boom"); });
    assert.deepEqual(roles(), ["user", "assistant", "error"]);
    assert.equal(chat.messages[1].content, "half");
  });

  await test("stream error: identical consecutive error bubbles are not duplicated (send)", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); streams[0].onError("boom"); });
    assert.equal(roles().filter((r) => r === "error").length, 1);
  });

  await test("stream failing before any chat id exists wipes the empty new chat (current behavior)", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onError("boom"); });
    assert.equal(chat.messages.length, 0);
    assert.equal(chat.isLoading, false);
  });

  await test("stream error for a new chat that already has an id still updates the URL and sidebar", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("77"); streams[0].onError("boom"); });
    assert.deepEqual(replaced, ["/chat?chatId=77"]);
    assert.deepEqual(events, ["chat-created"]);
  });

  // ------------------------------------------------------------------ retry
  await test("retry after a stream error: re-streams the same text in the same chat without duplicating messages", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi there"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    assert.deepEqual(roles(), ["user", "error"]);
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(streams.length, 2);
    assert.equal(streams[1].message, "hi there");
    assert.equal(streams[1].chatId, "42");
    assert.ok(!streams[1].documentId);
    assert.deepEqual(roles(), ["user", "assistant"], "error bubble replaced by a fresh assistant placeholder, user message kept once");
    assert.equal(chat.isLoading, true);
    await act(async () => { streams[1].onChunk("Retried "); streams[1].onChunk("answer"); });
    assert.equal(chat.messages[1].content, "Retried answer");
    await act(async () => { streams[1].onComplete(); });
    assert.equal(chat.isLoading, false);
    assert.deepEqual(contents(), ["hi there", "Retried answer"]);
  });

  await test("retry for a document-backed message re-streams with the documentId and the visible content, without re-uploading", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("what is this?", file("report.pdf")); });
    await act(async () => { streams[0].onChatId("12"); streams[0].onError("boom"); });
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(uploads.length, 1, "no second upload");
    assert.equal(streams[1].message, "📄 report.pdf\n\nwhat is this?");
    assert.equal(streams[1].documentId, 7);
    assert.equal(streams[1].chatId, "12");
    assert.equal(chat.messages.filter((m) => m.role === "user").length, 1);
  });

  await test("retry when the upload itself failed re-runs the whole send (upload again, new user message)", async () => {
    let attempts = 0;
    uploadImpl = async (f) => { attempts++; if (attempts === 1) throw new Error("Invalid file content"); return { id: 9, filename: f.name, file_type: "pdf", character_count: 1, chunk_count: 1 }; };
    await mount();
    await act(async () => { await chat.sendMessage("q", file("a.pdf")); });
    assert.deepEqual(roles(), ["error"]);
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(uploads.length, 2);
    assert.equal(streams[0].documentId, 9);
    assert.deepEqual(roles(), ["user", "assistant"]);
  });

  await test("retry keeps the voice flag of the original request", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("spoken", null, true); });
    await act(async () => { streams[0].onChatId("3"); streams[0].onError("boom"); });
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(streams[1].isVoice, true);
  });

  await test("retry success after a new-chat error: the URL was already rewritten at error time, so completion adds no second rewrite", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    assert.deepEqual(replaced, ["/chat?chatId=42"]);
    assert.deepEqual(events, ["chat-created"]);
    replaced.length = 0; events.length = 0;
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onChunk("ok"); streams[1].onComplete(); });
    assert.equal(chat.isLoading, false);
    assert.deepEqual(replaced, []);
    await act(async () => { clock.advance(15000); });
    assert.deepEqual(events, [], "no extra sidebar refreshes");
  });

  await test("retry failing again: replaces the placeholder with a new error (no duplicate-suppression, no URL update)", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    replaced.length = 0; events.length = 0;
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onError("boom"); });
    assert.deepEqual(roles(), ["user", "error"]);
    assert.equal(chat.isLoading, false);
    assert.deepEqual(replaced, []);
    assert.deepEqual(events, []);
    // and it can be retried again
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(streams.length, 3);
  });

  await test("error logging and de-duplication differ between send and retry (send logs + de-duplicates, retry does neither)", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    assert.equal(warns.filter((w) => w.includes("streamMessage error")).length, 1);
    warns.length = 0;
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onChunk("x"); streams[1].onError("boom"); streams[1].onError("boom"); });
    assert.equal(warns.filter((w) => w.includes("streamMessage error")).length, 0, "retry does not log stream errors");
    assert.deepEqual(roles(), ["user", "assistant", "error", "error"], "retry does not suppress an identical consecutive error");
  });

  await test("retry can be aborted: stop cancels the retried stream and clears loading", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onChunk("part"); });
    await act(async () => { chat.stopGeneration(); });
    await flush();
    assert.ok(streams[1].controller.signal.aborted);
    assert.equal(chat.isLoading, false);
    assert.equal(chat.messages[chat.messages.length - 1].content, "part");
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(streams.length, 2, "nothing left to retry after a user stop");
  });

  await test("retry is ignored while loading or when there is no error", async () => {
    await mount();
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(streams.length, 0);
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(streams.length, 1);
  });

  await test("retry only removes the most recent error bubble", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("one"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("first"); });
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onChunk("ok"); streams[1].onComplete(); });
    await act(async () => { await chat.sendMessage("two"); });
    await act(async () => { streams[2].onError("second"); });
    await act(async () => { await chat.retryLastMessage(); });
    assert.deepEqual(contents(), ["one", "ok", "two", ""]);
    assert.deepEqual(roles(), ["user", "assistant", "user", "assistant"]);
  });

  // ------------------------------------------------------------------ regenerate
  await test("regenerate: clears the reply, streams new tokens into the same message", async () => {
    historyImpl = async () => ({ id: 5, title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
      messages: [{ id: 1, role: "user", content: "q", created_at: "2026-01-01T00:00:00" }, { id: 2, role: "assistant", content: "old a", created_at: "2026-01-01T00:00:01" }] });
    await mount({ chatId: "5" });
    const id = chat.messages[1].id;
    await act(async () => { chat.regenerateResponse(id); });
    assert.equal(regens[0].chatId, "5");
    assert.equal(chat.messages[1].content, "");
    assert.equal(chat.isLoading, true);
    await act(async () => { regens[0].onChunk("new "); regens[0].onChunk("answer"); regens[0].onComplete(); });
    assert.equal(chat.messages[1].content, "new answer");
    assert.equal(chat.isLoading, false);
    assert.equal(chat.messages[1].id, id);
  });

  await test("regenerate error restores the old reply and appends the error; retry then regenerates again", async () => {
    historyImpl = async () => ({ id: 5, title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
      messages: [{ id: 1, role: "user", content: "q", created_at: "2026-01-01T00:00:00" }, { id: 2, role: "assistant", content: "old a", created_at: "2026-01-01T00:00:01" }] });
    await mount({ chatId: "5" });
    const id = chat.messages[1].id;
    await act(async () => { chat.regenerateResponse(id, true); });
    assert.equal(regens[0].isVoice, true);
    await act(async () => { regens[0].onError("regen failed"); });
    assert.deepEqual(contents(), ["q", "old a", "regen failed"]);
    assert.deepEqual(roles(), ["user", "assistant", "error"]);
    await act(async () => { await chat.retryLastMessage(); });
    assert.equal(regens.length, 2);
    assert.equal(regens[1].isVoice, true);
    assert.deepEqual(roles(), ["user", "assistant"]);
  });

  await test("regenerate only applies to an existing assistant message in an existing chat", async () => {
    await mount();
    await act(async () => { chat.regenerateResponse("nope"); });
    assert.equal(regens.length, 0);
  });

  // ------------------------------------------------------------------ chat switching / lifecycle
  await test("new-chat event clears messages and aborts a running stream", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { window.dispatchEvent(new window.Event("new-chat")); });
    assert.equal(chat.messages.length, 0);
    assert.equal(chat.isLoading, false);
    assert.ok(streams[0].controller.signal.aborted);
  });

  await test("unmount aborts the running stream", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    const controller = streams[0].controller;
    await unmount();
    assert.ok(controller.signal.aborted);
  });

  await test("public API: the hook returns exactly the documented members", async () => {
    await mount();
    assert.deepEqual(Object.keys(chat).sort(), ["clearChat", "isLoading", "isUploading", "messages", "regenerateResponse", "retryLastMessage", "sendMessage", "stopGeneration"]);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (process.env.CHAT_TEST_JSON) (await import("node:fs")).writeFileSync(process.env.CHAT_TEST_JSON, JSON.stringify(results, null, 1));
  process.exit(failures.length ? 1 : 0);
}

main();
