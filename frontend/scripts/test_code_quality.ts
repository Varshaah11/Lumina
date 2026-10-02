/**
 * Batch 4A tests: shared API types, error helpers, ApiError parsing, SSE event parsing, and the development-only
 * debug logging / test-bridge switch. Run from frontend/ (no test runner is installed):
 *   OUT=$(mktemp -d) && npx tsc -p scripts/tsconfig.test.json --outDir $OUT \
 *     && cp scripts/next_navigation_stub.js $OUT/scripts/ && NODE_PATH=$PWD/node_modules node $OUT/scripts/test_code_quality.js
 */
import { FakeRecognition } from "./mic_test_support";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { getErrorMessage, isAbortError } from "../lib/errors";
import { api, ApiError } from "../services/api";
import { chatService } from "../services/chat";
import type { ChatDetail, ChatStreamEvent, ChatSummary } from "../types/api";

const g = globalThis as unknown as { fetch: unknown; window: Window & { __luminaVoice?: unknown } };
let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  [FAIL] ${name}\n         ${(e as Error).message}`);
  }
}

function mockFetch(status: number, body: unknown, contentType = "application/json") {
  g.fetch = async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

function sseResponse(events: string[]) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const e of events) controller.enqueue(enc.encode(e));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function freshModules(): { debug: typeof import("../lib/debug") } {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](lib[\\/]debug|hooks[\\/]useVoiceConversation)\.js$/.test(key)) delete require.cache[key];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { debug: require("../lib/debug") };
}

async function withNodeEnv<T>(env: { NODE_ENV: string; NEXT_PUBLIC_DEBUG_VOICE?: string }, fn: () => Promise<T> | T): Promise<T> {
  const saved = { ...process.env };
  (process.env as Record<string, string | undefined>).NODE_ENV = env.NODE_ENV;
  if (env.NEXT_PUBLIC_DEBUG_VOICE === undefined) delete process.env.NEXT_PUBLIC_DEBUG_VOICE;
  else process.env.NEXT_PUBLIC_DEBUG_VOICE = env.NEXT_PUBLIC_DEBUG_VOICE;
  try {
    return await fn();
  } finally {
    for (const k of ["NODE_ENV", "NEXT_PUBLIC_DEBUG_VOICE"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function mountHookAndOpenVoiceMode(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useVoiceConversation } = require("../hooks/useVoiceConversation") as typeof import("../hooks/useVoiceConversation");
  function Harness(props: { isOpen: boolean }) {
    useVoiceConversation({ sendMessage: () => {}, stopGeneration: () => {}, isLoading: false, messages: [], isOpen: props.isOpen });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Harness, { isOpen: false })); });
  await act(async () => { root.render(React.createElement(Harness, { isOpen: true })); });
  await act(async () => { FakeRecognition.instances.forEach((i) => i.fireStart()); });
  await act(async () => { root.unmount(); });
}

async function main() {
  console.log("\n=== Batch 4A code-quality tests ===");

  await test("API types mirror the backend schemas (compile-time + JSON round trip)", () => {
    const summary: ChatSummary = { id: 1, title: "t", created_at: "2026-10-02T10:00:00", updated_at: "2026-10-02T10:00:05" };
    const detail: ChatDetail = { ...summary, messages: [{ id: 7, role: "assistant", content: "hi", created_at: "2026-10-02T10:00:05" }] };
    const event: ChatStreamEvent = JSON.parse('{"token": "x"}');
    assert.equal(detail.messages[0].id, 7);
    assert.equal(event.token, "x");
    // Field names must match backend/app/schemas/chat.py
    const backend = fs.readFileSync(path.join(process.cwd(), "..", "backend/app/schemas/chat.py"), "utf8");
    for (const field of ["id", "title", "created_at", "updated_at", "messages", "role", "content"]) {
      assert.match(backend, new RegExp(`\\b${field}\\b`), `backend schema lacks ${field}`);
    }
  });

  await test("getErrorMessage: Error, ApiError, plain object, string, null, empty message", () => {
    assert.equal(getErrorMessage(new Error("boom"), "fb"), "boom");
    assert.equal(getErrorMessage(new ApiError(400, "bad request", { detail: "x" }), "fb"), "bad request");
    assert.equal(getErrorMessage({ message: "obj" }, "fb"), "obj");
    assert.equal(getErrorMessage("just a string", "fb"), "fb");
    assert.equal(getErrorMessage(null, "fb"), "fb");
    assert.equal(getErrorMessage(undefined, "fb"), "fb");
    assert.equal(getErrorMessage(new Error(""), "fb"), "fb");
  });

  await test("isAbortError recognises AbortError only", () => {
    const abort = new Error("aborted"); abort.name = "AbortError";
    assert.equal(isAbortError(abort), true);
    assert.equal(isAbortError(new DOMException("x", "AbortError")), true);
    assert.equal(isAbortError(new Error("other")), false);
    assert.equal(isAbortError(null), false);
    assert.equal(isAbortError("AbortError"), false);
  });

  await test("api(): FastAPI error shapes become ApiError messages", async () => {
    mockFetch(401, { detail: "Incorrect email or password" });
    await assert.rejects(() => api("/x"), (e: unknown) => e instanceof ApiError && e.status === 401 && e.message === "Incorrect email or password");
    mockFetch(422, { detail: [{ loc: ["body", "password"], msg: "String should have at least 8 characters", type: "string_too_short" }] });
    await assert.rejects(() => api("/x"), (e: unknown) => e instanceof ApiError && e.message === "String should have at least 8 characters");
    mockFetch(413, { detail: "File is too large" });
    await assert.rejects(() => api("/x"), (e: unknown) => e instanceof ApiError && e.status === 413 && e.message === "File is too large");
    mockFetch(500, { message: "plain message" });
    await assert.rejects(() => api("/x"), (e: unknown) => e instanceof ApiError && e.message === "plain message");
    mockFetch(502, "<html>bad gateway</html>", "text/html");
    await assert.rejects(() => api("/x"), (e: unknown) => e instanceof ApiError && e.message === "An error occurred" && e.data === "<html>bad gateway</html>");
  });

  await test("api(): typed success responses pass through unchanged", async () => {
    const chats: ChatSummary[] = [{ id: 2, title: "a", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-02T00:00:00" }];
    mockFetch(200, chats);
    assert.deepEqual(await chatService.getChats(), chats);
  });

  await test("SSE parsing: chat_id, tokens (including empty), and error events reach the right callbacks", async () => {
    g.fetch = async () =>
      sseResponse(['data: {"chat_id": 12}\n\n', 'data: {"token": "Hel"}\n\ndata: {"token": ""}\n\n', 'data: {"token": "lo"}\n\n']);
    const got: { id?: string; text: string; done: boolean; error?: string } = { text: "", done: false };
    await new Promise<void>((resolve) => {
      chatService.streamMessage("hi", null, (t) => { got.text += t; }, (id) => { got.id = id; }, (e) => { got.error = e; resolve(); }, () => { got.done = true; resolve(); });
    });
    assert.deepEqual(got, { id: "12", text: "Hello", done: true });

    g.fetch = async () => sseResponse(['data: {"token": "partial"}\n\n', 'data: {"error": "Lumina couldn\'t connect. Please try again later."}\n\n']);
    const err: { text: string; error?: string; done: boolean } = { text: "", done: false };
    await new Promise<void>((resolve) => {
      chatService.streamMessage("hi", "3", (t) => { err.text += t; }, () => {}, (e) => { err.error = e; resolve(); }, () => { err.done = true; resolve(); });
    });
    assert.equal(err.text, "partial");
    assert.equal(err.error, "Lumina couldn't connect. Please try again later.");
    assert.equal(err.done, false);
  });

  await test("SSE request payload follows ChatStreamPayload (chat_id/document_id/is_voice only when set)", async () => {
    const bodies: unknown[] = [];
    g.fetch = async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return sseResponse([]); };
    await new Promise<void>((resolve) => chatService.streamMessage("a", null, () => {}, () => {}, () => resolve(), () => resolve()));
    await new Promise<void>((resolve) => chatService.streamMessage("b", "5", () => {}, () => {}, () => resolve(), () => resolve(), true, 9));
    assert.deepEqual(bodies, [{ message: "a" }, { message: "b", chat_id: 5, document_id: 9, is_voice: true }]);
  });

  await test("debugLog: silent in production, on in development, opt-in flag in production", async () => {
    const calls: unknown[][] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => { calls.push(a); };
    try {
      await withNodeEnv({ NODE_ENV: "production" }, () => { freshModules().debug.debugLog("prod"); });
      assert.equal(calls.length, 0, "production must not log");
      await withNodeEnv({ NODE_ENV: "development" }, () => { freshModules().debug.debugLog("dev"); });
      assert.deepEqual(calls, [["dev"]]);
      await withNodeEnv({ NODE_ENV: "production", NEXT_PUBLIC_DEBUG_VOICE: "true" }, () => { freshModules().debug.debugLog("opt-in"); });
      assert.equal(calls.length, 2);
    } finally {
      console.log = original;
    }
  });

  await test("voice hook: production build logs nothing via console.log and exposes no window test bridge", async () => {
    const calls: unknown[][] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => { calls.push(a); };
    FakeRecognition.instances.length = 0;
    delete (g.window as { __luminaVoice?: unknown }).__luminaVoice;
    try {
      await withNodeEnv({ NODE_ENV: "production" }, async () => { freshModules(); await mountHookAndOpenVoiceMode(); });
    } finally {
      console.log = original;
    }
    assert.equal(calls.length, 0, `unexpected console.log: ${JSON.stringify(calls[0])}`);
    assert.equal(g.window.__luminaVoice, undefined);
    assert.ok(FakeRecognition.instances.length >= 1, "voice mode itself still works in production");
  });

  await test("voice hook: development build keeps diagnostics and the test bridge", async () => {
    const calls: unknown[][] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => { calls.push(a); };
    FakeRecognition.instances.length = 0;
    try {
      await withNodeEnv({ NODE_ENV: "development" }, async () => {
        freshModules();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { useVoiceConversation } = require("../hooks/useVoiceConversation") as typeof import("../hooks/useVoiceConversation");
        function Harness() {
          useVoiceConversation({ sendMessage: () => {}, stopGeneration: () => {}, isLoading: false, messages: [], isOpen: true });
          return null;
        }
        const root = createRoot(document.createElement("div"));
        await act(async () => { root.render(React.createElement(Harness)); });
        assert.equal(typeof (g.window.__luminaVoice as { getState?: unknown } | undefined)?.getState, "function");
        await act(async () => { root.unmount(); });
      });
    } finally {
      console.log = original;
    }
    assert.ok(calls.length > 0, "dev diagnostics should still be logged");
  });

  await test("source guards: no console.log in the voice hook and no explicit any in the typed modules", () => {
    const root = process.cwd();
    const hook = fs.readFileSync(path.join(root, "hooks/useVoiceConversation.ts"), "utf8");
    assert.equal((hook.match(/console\.log\(/g) || []).length, 0);
    assert.ok(/console\.(warn|error)\(/.test(hook), "error/warn logging must be kept");
    for (const rel of ["services/api.ts", "services/chat.ts", "hooks/useChat.ts", "types/api.ts", "types/speech.ts", "lib/errors.ts", "lib/debug.ts",
                       "app/history/page.tsx", "components/layout/Sidebar.tsx", "components/chat/ChatBubble.tsx", "components/chat/VoiceAssistantOverlay.tsx"]) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      assert.doesNotMatch(text, /:\s*any\b|\bas any\b|<any[\[>,]|any\[\]/, `${rel} still uses any`);
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main();
