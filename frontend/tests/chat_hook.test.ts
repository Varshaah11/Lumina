/**
 * Behavior (characterization) tests for useChat: send, document-backed send, streaming, stop/abort, errors, retry,
 * regenerate, chat-id/URL/sidebar updates. chatService is replaced by a controllable fake; assertions are on observable
 * behavior only (messages, isLoading, requests made, events dispatched), so they hold across internal refactors.
 * Migrated 1:1 from the former custom harness scripts/test_chat_hook.ts (35 checks).
 */
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "@/hooks/useChat";
import { chatService, type UploadFileResponse } from "@/services/chat";
import type { ChatDetail } from "@/types/api";
import { installFakeClock } from "./support/fakeClock";

vi.mock("next/navigation", () => import("./support/nextNavigation"));

type Chat = ReturnType<typeof useChat>;

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
let uploadImpl: (file: File) => Promise<UploadFileResponse>;
let historyImpl: (id: string) => Promise<ChatDetail>;
const historyCalls: string[] = [];

function emulateAbort(controller: AbortController, onComplete: () => void) {
  // The real SSE helper reports an aborted stream through onComplete (AbortError path)
  controller.signal.addEventListener("abort", () => { Promise.resolve().then(onComplete); });
}
function installFakeChatService() {
  vi.spyOn(chatService, "streamMessage").mockImplementation((message, chatId, onChunk, onChatId, onError, onComplete, isVoice, documentId) => {
    const controller = new AbortController();
    emulateAbort(controller, onComplete);
    streams.push({ message, chatId, isVoice, documentId, onChunk, onChatId, onError, onComplete, controller });
    return controller;
  });
  vi.spyOn(chatService, "regenerateMessage").mockImplementation((chatId, onChunk, onError, onComplete, isVoice = false) => {
    const controller = new AbortController();
    emulateAbort(controller, onComplete);
    regens.push({ chatId, isVoice, onChunk, onError, onComplete, controller });
    return controller;
  });
  vi.spyOn(chatService, "uploadFile").mockImplementation(async (file, signal, chatId) => {
    uploads.push({ name: file.name, chatId, aborted: () => !!signal?.aborted });
    return uploadImpl(file);
  });
  vi.spyOn(chatService, "getChatHistory").mockImplementation(async (id) => { historyCalls.push(id); return historyImpl(id); });
}

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

beforeEach(() => {
  streams.length = 0; regens.length = 0; uploads.length = 0; historyCalls.length = 0; events.length = 0; replaced.length = 0;
  uploadImpl = async (f) => ({ id: 7, filename: f.name, file_type: "pdf", character_count: 10, chunk_count: 1 });
  historyImpl = async (id) => ({ id: Number(id), title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00", messages: [] });
  warns.length = 0;
  installFakeChatService();
  vi.spyOn(window.history, "replaceState").mockImplementation((data: unknown, unused: string, url?: string | URL | null) => {
    replaced.push(String(url));
    origReplace(data, unused, url);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
  installFakeClock();
  for (const t of ["chat-created", "chats-updated"]) window.addEventListener(t, onEvent);
});

afterEach(async () => {
  await unmount();
  for (const t of ["chat-created", "chats-updated"]) window.removeEventListener(t, onEvent);
});

describe("useChat", () => {


  // ------------------------------------------------------------------ sendMessage
  it("send: new chat adds user + empty assistant message, streams, accumulates tokens", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("  hello there  "); });
    expect(roles()).toStrictEqual(["user", "assistant"]);
    expect(contents()).toStrictEqual(["hello there", ""]);
    expect(chat.isLoading).toBe(true);
    expect(streams.length).toBe(1);
    expect(streams[0].message).toBe("hello there");
    expect(streams[0].chatId).toBe(null);
    expect(streams[0].documentId).toBe(null);
    expect(!streams[0].isVoice).toBeTruthy();
    await act(async () => { streams[0].onChunk("Hel"); streams[0].onChunk("lo"); streams[0].onChunk(" world"); });
    expect(chat.messages[1].content).toBe("Hello world");
    expect(chat.messages[0].content).toBe("hello there");
  });

  it("send: ids are unique and timestamps set", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    const ids = chat.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(chat.messages.every((m) => m.timestamp instanceof Date)).toBeTruthy();
  });

  it("send: new chat id event updates URL, sidebar events fire on completion, titles refresh later", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hello"); });
    await act(async () => { streams[0].onChatId("42"); });
    expect(replaced, "URL is not rewritten until the stream ends").toStrictEqual([]);
    await act(async () => { streams[0].onChunk("ok"); streams[0].onComplete(); });
    expect(chat.isLoading).toBe(false);
    expect(replaced).toStrictEqual(["/chat?chatId=42"]);
    expect(events).toStrictEqual(["chat-created"]);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(events).toStrictEqual(["chat-created", "chats-updated"]);
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(events).toStrictEqual(["chat-created", "chats-updated", "chats-updated"]);
  });

  it("send: the second message in the same chat uses the chat id and does not rewrite the URL", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hello"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onChunk("ok"); streams[0].onComplete(); });
    replaced.length = 0; events.length = 0;
    await act(async () => { await chat.sendMessage("and again"); });
    expect(streams[1].chatId).toBe("42");
    await act(async () => { streams[1].onChunk("sure"); streams[1].onComplete(); });
    expect(chat.isLoading).toBe(false);
    expect(roles()).toStrictEqual(["user", "assistant", "user", "assistant"]);
    expect(replaced, "URL rewritten once per new chat").toStrictEqual([]);
  });

  it("send: existing chat from the URL loads history and sends with that chat id (no URL rewrite)", async () => {
    historyImpl = async () => ({ id: 5, title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
      messages: [{ id: 1, role: "user", content: "old q", created_at: "2026-01-01T00:00:00" }, { id: 2, role: "assistant", content: "old a", created_at: "2026-01-01T00:00:01" }] });
    await mount({ chatId: "5" });
    expect(historyCalls).toStrictEqual(["5"]);
    expect(contents()).toStrictEqual(["old q", "old a"]);
    expect(chat.isLoading).toBe(false);
    await act(async () => { await chat.sendMessage("follow up"); });
    expect(streams[0].chatId).toBe("5");
    await act(async () => { streams[0].onChunk("ok"); streams[0].onComplete(); });
    expect(replaced).toStrictEqual([]);
    expect(events).toStrictEqual([]);
    expect(contents()).toStrictEqual(["old q", "old a", "follow up", "ok"]);
  });

  it("send: empty text, whitespace and a send while loading are ignored", async () => {
    await mount();
    await act(async () => { await chat.sendMessage(""); await chat.sendMessage("   "); });
    expect(streams.length).toBe(0);
    await act(async () => { await chat.sendMessage("first"); });
    await act(async () => { await chat.sendMessage("second while loading"); });
    expect(streams.length).toBe(1);
    expect(chat.messages.length).toBe(2);
  });

  it("send: voice messages are flagged and the flag reaches the request", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("spoken question", null, true); });
    expect(streams[0].isVoice).toBe(true);
    expect(chat.messages[0].isVoice).toBe(true);
    expect(chat.messages[1].isVoice).toBe(true);
  });

  it("send with document: uploads first, shows the file header, sends documentId and visible content", async () => {
    await mount();
    await act(async () => { const p = chat.sendMessage("what is this?", file("report.pdf")); await p; });
    expect(uploads.length).toBe(1);
    expect(uploads[0].name).toBe("report.pdf");
    expect(uploads[0].chatId).toBe(null);
    expect(streams[0].message).toBe("📄 report.pdf\n\nwhat is this?");
    expect(streams[0].documentId).toBe(7);
    expect(chat.messages[0].content).toBe("📄 report.pdf\n\nwhat is this?");
    expect(chat.isUploading).toBe(false);
  });

  it("send with document and no text uses the default analysis prompt", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("", file("report.pdf")); });
    expect(streams[0].message).toBe("📄 report.pdf\n\nPlease analyze and summarize the contents of this document.");
  });

  it("send with document: upload progress state and chat id passed to the upload", async () => {
    await mount({ chatId: "9" });
    let release: (r: UploadFileResponse) => void = () => {};
    uploadImpl = () => new Promise((res) => { release = res; });
    let sending: Promise<void> | undefined;
    await act(async () => { sending = chat.sendMessage("q", file("a.pdf")); });
    expect(chat.isUploading).toBe(true);
    expect(chat.isLoading).toBe(true);
    expect(streams.length).toBe(0);
    expect(uploads[0].chatId).toBe("9");
    await act(async () => { release({ id: 3, filename: "a.pdf", file_type: "pdf", character_count: 1, chunk_count: 1 }); await sending; });
    expect(chat.isUploading).toBe(false);
    expect(streams[0].documentId).toBe(3);
    expect(streams[0].chatId).toBe("9");
  });

  it("upload failure: error bubble, loading cleared, no stream", async () => {
    uploadImpl = async () => { throw new Error("File is too large (maximum 10 MB)"); };
    await mount();
    await act(async () => { await chat.sendMessage("q", file()); });
    expect(roles()).toStrictEqual(["error"]);
    expect(chat.messages[0].content).toBe("File is too large (maximum 10 MB)");
    expect(chat.isLoading).toBe(false);
    expect(chat.isUploading).toBe(false);
    expect(streams.length).toBe(0);
  });

  it("upload aborted by stop: no error bubble, no stream", async () => {
    await mount();
    let reject: (e: Error) => void = () => {};
    uploadImpl = () => new Promise((_res, rej) => { reject = rej; });
    let sending: Promise<void> | undefined;
    await act(async () => { sending = chat.sendMessage("q", file()); });
    await act(async () => { chat.stopGeneration(); });
    const abort = new Error("aborted"); abort.name = "AbortError";
    await act(async () => { reject(abort); await sending; });
    expect(chat.messages.length).toBe(0);
    expect(chat.isLoading).toBe(false);
    expect(streams.length).toBe(0);
  });

  // ------------------------------------------------------------------ stop / abort / errors
  it("stop: aborts the stream, clears loading, keeps the partial reply and does not record a retry", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("tell me"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onChunk("partial answ"); });
    await act(async () => { chat.stopGeneration(); });
    await flush();
    expect(streams[0].controller.signal.aborted).toBeTruthy();
    expect(chat.isLoading).toBe(false);
    expect(chat.messages[1].content).toBe("partial answ");
    expect(roles()).toStrictEqual(["user", "assistant"]);
  });

  it("stop with nothing running is a no-op", async () => {
    await mount();
    await act(async () => { chat.stopGeneration(); });
    expect(chat.isLoading).toBe(false);
    expect(chat.messages.length).toBe(0);
  });

  it("stream error: empty placeholder replaced by one error bubble, loading cleared", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("Lumina couldn't connect. Please try again later."); });
    expect(roles()).toStrictEqual(["user", "error"]);
    expect(chat.messages[1].content).toBe("Lumina couldn't connect. Please try again later.");
    expect(chat.isLoading).toBe(false);
  });

  it("stream error after partial text keeps the partial reply and adds the error", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onChunk("half"); streams[0].onError("boom"); });
    expect(roles()).toStrictEqual(["user", "assistant", "error"]);
    expect(chat.messages[1].content).toBe("half");
  });

  it("stream error: identical consecutive error bubbles are not duplicated (send)", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); streams[0].onError("boom"); });
    expect(roles().filter((r) => r === "error").length).toBe(1);
  });

  it("stream failing before any chat id exists wipes the empty new chat (current behavior)", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onError("boom"); });
    expect(chat.messages.length).toBe(0);
    expect(chat.isLoading).toBe(false);
  });

  it("stream error for a new chat that already has an id still updates the URL and sidebar", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("77"); streams[0].onError("boom"); });
    expect(replaced).toStrictEqual(["/chat?chatId=77"]);
    expect(events).toStrictEqual(["chat-created"]);
  });

  // ------------------------------------------------------------------ retry
  it("retry after a stream error: re-streams the same text in the same chat without duplicating messages", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi there"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    expect(roles()).toStrictEqual(["user", "error"]);
    await act(async () => { await chat.retryLastMessage(); });
    expect(streams.length).toBe(2);
    expect(streams[1].message).toBe("hi there");
    expect(streams[1].chatId).toBe("42");
    expect(!streams[1].documentId).toBeTruthy();
    expect(roles(), "error bubble replaced by a fresh assistant placeholder, user message kept once").toStrictEqual(["user", "assistant"]);
    expect(chat.isLoading).toBe(true);
    await act(async () => { streams[1].onChunk("Retried "); streams[1].onChunk("answer"); });
    expect(chat.messages[1].content).toBe("Retried answer");
    await act(async () => { streams[1].onComplete(); });
    expect(chat.isLoading).toBe(false);
    expect(contents()).toStrictEqual(["hi there", "Retried answer"]);
  });

  it("retry for a document-backed message re-streams with the documentId and the visible content, without re-uploading", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("what is this?", file("report.pdf")); });
    await act(async () => { streams[0].onChatId("12"); streams[0].onError("boom"); });
    await act(async () => { await chat.retryLastMessage(); });
    expect(uploads.length, "no second upload").toBe(1);
    expect(streams[1].message).toBe("📄 report.pdf\n\nwhat is this?");
    expect(streams[1].documentId).toBe(7);
    expect(streams[1].chatId).toBe("12");
    expect(chat.messages.filter((m) => m.role === "user").length).toBe(1);
  });

  it("retry when the upload itself failed re-runs the whole send (upload again, new user message)", async () => {
    let attempts = 0;
    uploadImpl = async (f) => { attempts++; if (attempts === 1) throw new Error("Invalid file content"); return { id: 9, filename: f.name, file_type: "pdf", character_count: 1, chunk_count: 1 }; };
    await mount();
    await act(async () => { await chat.sendMessage("q", file("a.pdf")); });
    expect(roles()).toStrictEqual(["error"]);
    await act(async () => { await chat.retryLastMessage(); });
    expect(uploads.length).toBe(2);
    expect(streams[0].documentId).toBe(9);
    expect(roles()).toStrictEqual(["user", "assistant"]);
  });

  it("retry keeps the voice flag of the original request", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("spoken", null, true); });
    await act(async () => { streams[0].onChatId("3"); streams[0].onError("boom"); });
    await act(async () => { await chat.retryLastMessage(); });
    expect(streams[1].isVoice).toBe(true);
  });

  it("retry success after a new-chat error: the URL was already rewritten at error time, so completion adds no second rewrite", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    expect(replaced).toStrictEqual(["/chat?chatId=42"]);
    expect(events).toStrictEqual(["chat-created"]);
    replaced.length = 0; events.length = 0;
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onChunk("ok"); streams[1].onComplete(); });
    expect(chat.isLoading).toBe(false);
    expect(replaced).toStrictEqual([]);
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(events, "no extra sidebar refreshes").toStrictEqual([]);
  });

  it("retry failing again: replaces the placeholder with a new error (no duplicate-suppression, no URL update)", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    replaced.length = 0; events.length = 0;
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onError("boom"); });
    expect(roles()).toStrictEqual(["user", "error"]);
    expect(chat.isLoading).toBe(false);
    expect(replaced).toStrictEqual([]);
    expect(events).toStrictEqual([]);
    // and it can be retried again
    await act(async () => { await chat.retryLastMessage(); });
    expect(streams.length).toBe(3);
  });

  it("error logging and de-duplication differ between send and retry (send logs + de-duplicates, retry does neither)", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    expect(warns.filter((w) => w.includes("streamMessage error")).length).toBe(1);
    warns.length = 0;
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onChunk("x"); streams[1].onError("boom"); streams[1].onError("boom"); });
    expect(warns.filter((w) => w.includes("streamMessage error")).length, "retry does not log stream errors").toBe(0);
    expect(roles(), "retry does not suppress an identical consecutive error").toStrictEqual(["user", "assistant", "error", "error"]);
  });

  it("retry can be aborted: stop cancels the retried stream and clears loading", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("boom"); });
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onChunk("part"); });
    await act(async () => { chat.stopGeneration(); });
    await flush();
    expect(streams[1].controller.signal.aborted).toBeTruthy();
    expect(chat.isLoading).toBe(false);
    expect(chat.messages[chat.messages.length - 1].content).toBe("part");
    await act(async () => { await chat.retryLastMessage(); });
    expect(streams.length, "nothing left to retry after a user stop").toBe(2);
  });

  it("retry is ignored while loading or when there is no error", async () => {
    await mount();
    await act(async () => { await chat.retryLastMessage(); });
    expect(streams.length).toBe(0);
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { await chat.retryLastMessage(); });
    expect(streams.length).toBe(1);
  });

  it("retry only removes the most recent error bubble", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("one"); });
    await act(async () => { streams[0].onChatId("42"); streams[0].onError("first"); });
    await act(async () => { await chat.retryLastMessage(); });
    await act(async () => { streams[1].onChunk("ok"); streams[1].onComplete(); });
    await act(async () => { await chat.sendMessage("two"); });
    await act(async () => { streams[2].onError("second"); });
    await act(async () => { await chat.retryLastMessage(); });
    expect(contents()).toStrictEqual(["one", "ok", "two", ""]);
    expect(roles()).toStrictEqual(["user", "assistant", "user", "assistant"]);
  });

  // ------------------------------------------------------------------ regenerate
  it("regenerate: clears the reply, streams new tokens into the same message", async () => {
    historyImpl = async () => ({ id: 5, title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
      messages: [{ id: 1, role: "user", content: "q", created_at: "2026-01-01T00:00:00" }, { id: 2, role: "assistant", content: "old a", created_at: "2026-01-01T00:00:01" }] });
    await mount({ chatId: "5" });
    const id = chat.messages[1].id;
    await act(async () => { chat.regenerateResponse(id); });
    expect(regens[0].chatId).toBe("5");
    expect(chat.messages[1].content).toBe("");
    expect(chat.isLoading).toBe(true);
    await act(async () => { regens[0].onChunk("new "); regens[0].onChunk("answer"); regens[0].onComplete(); });
    expect(chat.messages[1].content).toBe("new answer");
    expect(chat.isLoading).toBe(false);
    expect(chat.messages[1].id).toBe(id);
  });

  it("regenerate error restores the old reply and appends the error; retry then regenerates again", async () => {
    historyImpl = async () => ({ id: 5, title: "t", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
      messages: [{ id: 1, role: "user", content: "q", created_at: "2026-01-01T00:00:00" }, { id: 2, role: "assistant", content: "old a", created_at: "2026-01-01T00:00:01" }] });
    await mount({ chatId: "5" });
    const id = chat.messages[1].id;
    await act(async () => { chat.regenerateResponse(id, true); });
    expect(regens[0].isVoice).toBe(true);
    await act(async () => { regens[0].onError("regen failed"); });
    expect(contents()).toStrictEqual(["q", "old a", "regen failed"]);
    expect(roles()).toStrictEqual(["user", "assistant", "error"]);
    await act(async () => { await chat.retryLastMessage(); });
    expect(regens.length).toBe(2);
    expect(regens[1].isVoice).toBe(true);
    expect(roles()).toStrictEqual(["user", "assistant"]);
  });

  it("regenerate only applies to an existing assistant message in an existing chat", async () => {
    await mount();
    await act(async () => { chat.regenerateResponse("nope"); });
    expect(regens.length).toBe(0);
  });

  // ------------------------------------------------------------------ chat switching / lifecycle
  it("new-chat event clears messages and aborts a running stream", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    await act(async () => { window.dispatchEvent(new window.Event("new-chat")); });
    expect(chat.messages.length).toBe(0);
    expect(chat.isLoading).toBe(false);
    expect(streams[0].controller.signal.aborted).toBeTruthy();
  });

  it("unmount aborts the running stream", async () => {
    await mount();
    await act(async () => { await chat.sendMessage("hi"); });
    const controller = streams[0].controller;
    await unmount();
    expect(controller.signal.aborted).toBeTruthy();
  });

  it("public API: the hook returns exactly the documented members", async () => {
    await mount();
    expect(Object.keys(chat).sort()).toStrictEqual(["clearChat", "isLoading", "isUploading", "messages", "regenerateResponse", "retryLastMessage", "sendMessage", "stopGeneration"]);
  });
});
