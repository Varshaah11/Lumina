/**
 * Batch 4A tests: shared API types, error helpers, ApiError parsing, SSE event parsing, and the development-only
 * debug logging / test-bridge switch. Migrated 1:1 from the former custom harness scripts/test_code_quality.ts (11 checks).
 *
 * The NODE_ENV-dependent checks reload modules with vi.resetModules() + dynamic import() under vi.stubEnv(), so every
 * module (the hook, lib/debug and the voice modules that import it) is evaluated in the environment being tested.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getErrorMessage, isAbortError } from "@/lib/errors";
import { api, ApiError } from "@/services/api";
import { chatService } from "@/services/chat";
import type { ChatDetail, ChatStreamEvent, ChatSummary } from "@/types/api";
import { FakeRecognition, installFakeSpeechRecognition } from "./support/speechRecognition";

vi.mock("next/navigation", () => import("./support/nextNavigation"));

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voiceWindow = window as Window & { __luminaVoice?: unknown };

function mockFetch(status: number, body: unknown, contentType = "application/json") {
  vi.stubGlobal("fetch", async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } }));
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

/** Re-evaluates every application module on the next import (so lib/debug re-reads process.env). */
async function freshModules(): Promise<{ debug: typeof import("@/lib/debug") }> {
  vi.resetModules();
  return { debug: await import("@/lib/debug") };
}

async function withNodeEnv<T>(env: { NODE_ENV: string; NEXT_PUBLIC_DEBUG_VOICE?: string }, fn: () => Promise<T> | T): Promise<T> {
  vi.stubEnv("NODE_ENV", env.NODE_ENV);
  vi.stubEnv("NEXT_PUBLIC_DEBUG_VOICE", env.NEXT_PUBLIC_DEBUG_VOICE);
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

async function mountHookAndOpenVoiceMode(): Promise<void> {
  const { useVoiceConversation } = await import("@/hooks/useVoiceConversation");
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

beforeEach(() => {
  installFakeSpeechRecognition();
});

describe("code quality", () => {
  it("API types mirror the backend schemas (compile-time + JSON round trip)", () => {
    const summary: ChatSummary = { id: 1, title: "t", created_at: "2026-10-02T10:00:00", updated_at: "2026-10-02T10:00:05" };
    const detail: ChatDetail = { ...summary, messages: [{ id: 7, role: "assistant", content: "hi", created_at: "2026-10-02T10:00:05" }] };
    const event: ChatStreamEvent = JSON.parse('{"token": "x"}');
    expect(detail.messages[0].id).toBe(7);
    expect(event.token).toBe("x");
    // Field names must match backend/app/schemas/chat.py
    const backend = fs.readFileSync(path.join(FRONTEND_ROOT, "..", "backend/app/schemas/chat.py"), "utf8");
    for (const field of ["id", "title", "created_at", "updated_at", "messages", "role", "content"]) {
      expect(backend, `backend schema lacks ${field}`).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it("getErrorMessage: Error, ApiError, plain object, string, null, empty message", () => {
    expect(getErrorMessage(new Error("boom"), "fb")).toBe("boom");
    expect(getErrorMessage(new ApiError(400, "bad request", { detail: "x" }), "fb")).toBe("bad request");
    expect(getErrorMessage({ message: "obj" }, "fb")).toBe("obj");
    expect(getErrorMessage("just a string", "fb")).toBe("fb");
    expect(getErrorMessage(null, "fb")).toBe("fb");
    expect(getErrorMessage(undefined, "fb")).toBe("fb");
    expect(getErrorMessage(new Error(""), "fb")).toBe("fb");
  });

  it("isAbortError recognises AbortError only", () => {
    const abort = new Error("aborted"); abort.name = "AbortError";
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });

  it("api(): FastAPI error shapes become ApiError messages", async () => {
    mockFetch(401, { detail: "Incorrect email or password" });
    await expect(api("/x")).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.status === 401 && e.message === "Incorrect email or password");
    mockFetch(422, { detail: [{ loc: ["body", "password"], msg: "String should have at least 8 characters", type: "string_too_short" }] });
    await expect(api("/x")).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.message === "String should have at least 8 characters");
    mockFetch(413, { detail: "File is too large" });
    await expect(api("/x")).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.status === 413 && e.message === "File is too large");
    mockFetch(500, { message: "plain message" });
    await expect(api("/x")).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.message === "plain message");
    mockFetch(502, "<html>bad gateway</html>", "text/html");
    await expect(api("/x")).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.message === "An error occurred" && e.data === "<html>bad gateway</html>");
  });

  it("api(): typed success responses pass through unchanged", async () => {
    const chats: ChatSummary[] = [{ id: 2, title: "a", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-02T00:00:00" }];
    mockFetch(200, chats);
    expect(await chatService.getChats()).toStrictEqual(chats);
  });

  it("SSE parsing: chat_id, tokens (including empty), and error events reach the right callbacks", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse(['data: {"chat_id": 12}\n\n', 'data: {"token": "Hel"}\n\ndata: {"token": ""}\n\n', 'data: {"token": "lo"}\n\n']));
    const got: { id?: string; text: string; done: boolean; error?: string } = { text: "", done: false };
    await new Promise<void>((resolve) => {
      chatService.streamMessage("hi", null, (t) => { got.text += t; }, (id) => { got.id = id; }, (e) => { got.error = e; resolve(); }, () => { got.done = true; resolve(); });
    });
    expect(got).toStrictEqual({ id: "12", text: "Hello", done: true });

    vi.stubGlobal("fetch", async () => sseResponse(['data: {"token": "partial"}\n\n', 'data: {"error": "Lumina couldn\'t connect. Please try again later."}\n\n']));
    const err: { text: string; error?: string; done: boolean } = { text: "", done: false };
    await new Promise<void>((resolve) => {
      chatService.streamMessage("hi", "3", (t) => { err.text += t; }, () => {}, (e) => { err.error = e; resolve(); }, () => { err.done = true; resolve(); });
    });
    expect(err.text).toBe("partial");
    expect(err.error).toBe("Lumina couldn't connect. Please try again later.");
    expect(err.done).toBe(false);
  });

  it("SSE request payload follows ChatStreamPayload (chat_id/document_id/is_voice only when set)", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return sseResponse([]); });
    await new Promise<void>((resolve) => chatService.streamMessage("a", null, () => {}, () => {}, () => resolve(), () => resolve()));
    await new Promise<void>((resolve) => chatService.streamMessage("b", "5", () => {}, () => {}, () => resolve(), () => resolve(), true, 9));
    expect(bodies).toStrictEqual([{ message: "a" }, { message: "b", chat_id: 5, document_id: 9, is_voice: true }]);
  });

  it("debugLog: silent in production, on in development, opt-in flag in production", async () => {
    const calls: unknown[][] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { calls.push(a); });
    try {
      await withNodeEnv({ NODE_ENV: "production" }, async () => { (await freshModules()).debug.debugLog("prod"); });
      expect(calls.length, "production must not log").toBe(0);
      await withNodeEnv({ NODE_ENV: "development" }, async () => { (await freshModules()).debug.debugLog("dev"); });
      expect(calls).toStrictEqual([["dev"]]);
      await withNodeEnv({ NODE_ENV: "production", NEXT_PUBLIC_DEBUG_VOICE: "true" }, async () => { (await freshModules()).debug.debugLog("opt-in"); });
      expect(calls.length).toBe(2);
    } finally {
      log.mockRestore();
    }
  });

  it("voice hook: production build logs nothing via console.log and exposes no window test bridge", async () => {
    const calls: unknown[][] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { calls.push(a); });
    FakeRecognition.instances.length = 0;
    delete voiceWindow.__luminaVoice;
    try {
      await withNodeEnv({ NODE_ENV: "production" }, async () => { await freshModules(); await mountHookAndOpenVoiceMode(); });
    } finally {
      log.mockRestore();
    }
    expect(calls.length, `unexpected console.log: ${JSON.stringify(calls[0])}`).toBe(0);
    expect(voiceWindow.__luminaVoice).toBe(undefined);
    expect(FakeRecognition.instances.length >= 1, "voice mode itself still works in production").toBeTruthy();
  });

  it("voice hook: development build keeps diagnostics and the test bridge", async () => {
    const calls: unknown[][] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { calls.push(a); });
    FakeRecognition.instances.length = 0;
    try {
      await withNodeEnv({ NODE_ENV: "development" }, async () => {
        await freshModules();
        const { useVoiceConversation } = await import("@/hooks/useVoiceConversation");
        function Harness() {
          useVoiceConversation({ sendMessage: () => {}, stopGeneration: () => {}, isLoading: false, messages: [], isOpen: true });
          return null;
        }
        const root = createRoot(document.createElement("div"));
        await act(async () => { root.render(React.createElement(Harness)); });
        expect(typeof (voiceWindow.__luminaVoice as { getState?: unknown } | undefined)?.getState).toBe("function");
        await act(async () => { root.unmount(); });
      });
    } finally {
      log.mockRestore();
    }
    expect(calls.length > 0, "dev diagnostics should still be logged").toBeTruthy();
  });

  it("the backend URL is configured in one place: a localhost default, overridable with NEXT_PUBLIC_API_URL", async () => {
    vi.resetModules();
    expect((await import("@/lib/config")).API_BASE_URL).toBe("http://localhost:8000");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
    vi.resetModules();
    expect((await import("@/lib/config")).API_BASE_URL).toBe("https://api.example.test");
    vi.unstubAllEnvs();

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(FRONTEND_ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(entry.name) && rel !== path.join("lib", "config.ts")
                 && /NEXT_PUBLIC_API_URL|localhost:8000/.test(fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8"))) {
          offenders.push(rel);
        }
      }
    };
    ["app", "components", "context", "hooks", "lib", "services", "types"].forEach(walk);
    expect(offenders).toStrictEqual([]);
  });

  it("source guards: no console.log in the voice hook and no explicit any in the typed modules", () => {
    const root = FRONTEND_ROOT;
    const hook = fs.readFileSync(path.join(root, "hooks/useVoiceConversation.ts"), "utf8");
    expect((hook.match(/console\.log\(/g) || []).length).toBe(0);
    expect(/console\.(warn|error)\(/.test(hook), "error/warn logging must be kept").toBeTruthy();
    for (const rel of ["services/api.ts", "services/chat.ts", "hooks/useChat.ts", "types/api.ts", "types/speech.ts", "lib/errors.ts", "lib/debug.ts",
                       "app/history/page.tsx", "components/layout/Sidebar.tsx", "components/chat/ChatBubble.tsx", "components/chat/VoiceAssistantOverlay.tsx"]) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      expect(text, `${rel} still uses any`).not.toMatch(/:\s*any\b|\bas any\b|<any[\[>,]|any\[\]/);
    }
  });
});
