/**
 * State-handling behavior of components whose effects were reworked for the React hooks lint rules: ChatInput (prompt
 * query parameter, voice-input support detection, clearing an attachment on "new-chat"), Topbar (mobile menu closes on
 * navigation), Sidebar (active chat follows the URL), the history page (loads chats on mount) and the profile page
 * (shows and edits the signed-in user's profile). Written against the original implementation first, so they pin the
 * behavior the refactor must preserve.
 */
import React, { act, useState } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "@/components/chat/ChatInput";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { AuthContext } from "@/context/AuthContext";
import { authService, type User } from "@/services/auth";
import { chatService } from "@/services/chat";
import type { ChatSummary } from "@/types/api";
import { greetingForHour, SERVER_GREETING, useTimeOfDayGreeting } from "@/hooks/useTimeOfDayGreeting";
import HistoryPage from "@/app/history/page";
import ProfilePage from "@/app/profile/page";
import { FakeRecognition } from "./support/speechRecognition";

vi.mock("next/navigation", () => import("./support/nextNavigation"));
// Pages are tested on their own content; the layout (auth redirect, sidebar, top bar) is covered separately
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => children,
}));

type AuthValue = React.ContextType<typeof AuthContext>;
const USER: User = { id: 1, name: "Sam Rivers", email: "sam@example.com", location: "Lisbon", bio: "Builds things." } as User;

function authValue(over: Partial<NonNullable<AuthValue>> = {}): NonNullable<AuthValue> {
  return {
    user: USER, isAuthenticated: true, isLoading: false,
    login: async () => {}, register: async () => {}, logout: async () => {}, updateUser: () => {}, refreshUser: async () => {},
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

async function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(element); });
}
async function rerender(element: React.ReactElement) {
  await act(async () => { root!.render(element); });
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function setUrl(url: string) { window.history.replaceState(null, "", url); }
const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement;
const byText = (text: string, scope: ParentNode = document.body) =>
  Array.from(scope.querySelectorAll("*")).find((el) => el.children.length === 0 && el.textContent?.trim() === text) ?? null;

beforeEach(() => {
  setUrl("/");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  document.body.innerHTML = "";
});

describe("ChatInput", () => {
  const input = () => <ChatInput onSend={() => {}} isLoading={false} />;

  it("pre-fills the message box from the ?prompt= query parameter", async () => {
    setUrl("/chat?prompt=Summarise%20my%20notes");
    await render(input());
    expect(textarea().value).toBe("Summarise my notes");
  });

  it("follows a new ?prompt= value", async () => {
    setUrl("/chat?prompt=First");
    await render(input());
    setUrl("/chat?prompt=Second");
    await rerender(input());
    expect(textarea().value).toBe("Second");
  });

  it("leaves the message box empty without a prompt parameter", async () => {
    setUrl("/chat");
    await render(input());
    expect(textarea().value).toBe("");
  });

  it("offers voice input when the browser supports speech recognition", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    await render(input());
    expect(container.querySelector('[title="Start voice input"]')).not.toBeNull();
  });

  it("explains when the browser has no speech recognition", async () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    await render(input());
    expect(container.querySelector(`[title="Voice input isn't supported in this browser"]`)).not.toBeNull();
  });

  it("clicking voice input in an unsupported browser shows a notice instead of failing", async () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    await render(input());
    const mic = container.querySelector(`[title="Voice input isn't supported in this browser"]`) as HTMLButtonElement;
    await act(async () => { mic.click(); });
    expect(container.textContent).toContain("Voice input isn't supported in this browser.");
  });

  it("drops an attached file when a new chat starts", async () => {
    await render(input());
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [new File(["x"], "report.pdf")], configurable: true });
    await act(async () => { fileInput.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(byText("report.pdf", container)).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("new-chat")); });
    expect(byText("report.pdf", container)).toBeNull();
  });
});

describe("Topbar", () => {
  const topbar = () => <AuthContext.Provider value={authValue()}><Topbar /></AuthContext.Provider>;
  const menuOpen = () => byText("Mobile Menu") !== null;

  it("closes the mobile menu when the route changes", async () => {
    setUrl("/dashboard");
    await render(topbar());
    const trigger = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Toggle menu"))!;
    await act(async () => { trigger.click(); });
    await flush();
    expect(menuOpen()).toBe(true);

    setUrl("/history");
    await rerender(topbar());
    await flush();
    expect(menuOpen()).toBe(false);
  });

  it("keeps the mobile menu open while the route stays the same", async () => {
    setUrl("/dashboard");
    await render(topbar());
    const trigger = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Toggle menu"))!;
    await act(async () => { trigger.click(); });
    await rerender(topbar());
    await flush();
    expect(menuOpen()).toBe(true);
  });
});

describe("Sidebar", () => {
  const CHATS: ChatSummary[] = [
    { id: 1, title: "Rivers", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00" },
    { id: 2, title: "Lakes", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00" },
  ];
  const sidebar = () => (
    <AuthContext.Provider value={authValue()}><Sidebar isCollapsed={false} setIsCollapsed={() => {}} /></AuthContext.Provider>
  );
  const isHighlighted = (title: string) => {
    const row = byText(title, container)?.closest("div.relative");
    return !!row && row.className.includes("bg-indigo-500/10");
  };

  beforeEach(() => {
    vi.spyOn(chatService, "getChats").mockResolvedValue(CHATS);
  });

  it("highlights the chat named in the URL and follows URL changes", async () => {
    setUrl("/chat?chatId=2");
    await render(sidebar());
    await flush();
    expect(isHighlighted("Lakes")).toBe(true);
    expect(isHighlighted("Rivers")).toBe(false);

    setUrl("/chat?chatId=1");
    await rerender(sidebar());
    await flush();
    expect(isHighlighted("Rivers")).toBe(true);
    expect(isHighlighted("Lakes")).toBe(false);
  });

  it("highlights nothing for a new chat", async () => {
    setUrl("/chat");
    await render(sidebar());
    await flush();
    expect(isHighlighted("Lakes")).toBe(false);
    expect(isHighlighted("Rivers")).toBe(false);
  });
});

describe("history page", () => {
  it("shows the loading state, then the user's chats", async () => {
    let resolve: (chats: ChatSummary[]) => void = () => {};
    vi.spyOn(chatService, "getChats").mockReturnValue(new Promise((r) => { resolve = r; }));
    await render(<HistoryPage />);
    expect(byText("Loading conversation history...", container)).not.toBeNull();
    await act(async () => { resolve([{ id: 3, title: "Deadlock notes", created_at: "2026-01-01T00:00:00", updated_at: "2026-01-02T00:00:00" }]); });
    await flush();
    expect(byText("Loading conversation history...", container)).toBeNull();
    expect(container.textContent).toContain("Deadlock notes");
  });

  it("stops loading when the request fails", async () => {
    vi.spyOn(chatService, "getChats").mockRejectedValue(new Error("offline"));
    await render(<HistoryPage />);
    await flush();
    expect(byText("Loading conversation history...", container)).toBeNull();
  });

  it("requests the chat list once on mount", async () => {
    const getChats = vi.spyOn(chatService, "getChats").mockResolvedValue([]);
    await render(<HistoryPage />);
    await flush();
    expect(getChats).toHaveBeenCalledTimes(1);
  });
});

describe("profile page", () => {
  /** Real provider behavior: updateUser replaces the signed-in user, which every consumer then sees. */
  function StatefulAuth({ initial, children }: { initial: User | null; children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(initial);
    return <AuthContext.Provider value={authValue({ user, updateUser: setUser })}>{children}</AuthContext.Provider>;
  }
  const editButton = () => container.querySelector('[aria-label="Edit Profile"]') as HTMLButtonElement | null;
  const field = (selector: string) => container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;

  it("shows the signed-in user's profile", async () => {
    await render(<StatefulAuth initial={USER}><ProfilePage /></StatefulAuth>);
    expect(container.textContent).toContain("Sam Rivers");
    expect(container.textContent).toContain("Lisbon");
    expect(container.textContent).toContain("Builds things.");
  });

  it("follows the user when the auth context changes (e.g. the session is restored after the first render)", async () => {
    await render(<AuthContext.Provider value={authValue({ user: null, isLoading: true })}><ProfilePage /></AuthContext.Provider>);
    await rerender(<AuthContext.Provider value={authValue({ user: { ...USER, name: "Restored Name" } })}><ProfilePage /></AuthContext.Provider>);
    expect(container.textContent).toContain("Restored Name");
    expect(container.textContent).toContain("Lisbon");
  });

  it("pre-fills the edit form with the current profile and discards edits on cancel", async () => {
    await render(<StatefulAuth initial={USER}><ProfilePage /></StatefulAuth>);
    await act(async () => { editButton()!.click(); });
    const name = field('input[type="text"]') as HTMLInputElement;
    expect(name.value).toBe("Sam Rivers");
    const cancel = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Cancel")!;
    await act(async () => { cancel.click(); });
    expect(container.textContent).toContain("Sam Rivers");
    expect(editButton()).not.toBeNull();
  });

  it("saves through the API and shows the saved profile", async () => {
    const saved = { ...USER, name: "Sam Lake", location: null, bio: "New bio" } as unknown as User;
    const update = vi.spyOn(authService, "updateProfile").mockResolvedValue(saved);
    await render(<StatefulAuth initial={USER}><ProfilePage /></StatefulAuth>);
    await act(async () => { editButton()!.click(); });
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(update).toHaveBeenCalledWith({ name: "Sam Rivers", location: "Lisbon", bio: "Builds things." });
    expect(container.textContent).toContain("Sam Lake");
    expect(container.textContent).toContain("New bio");
    expect(container.textContent).not.toContain("Lisbon");
    expect(editButton()).not.toBeNull();
  });
});

describe("time-of-day greeting (dashboard)", () => {
  function Greeting() {
    return <h1>{useTimeOfDayGreeting()}</h1>;
  }

  it("maps local hours to greetings", () => {
    expect([0, 11, 12, 17, 18, 23].map(greetingForHour)).toStrictEqual([
      "Good morning", "Good morning", "Good afternoon", "Good afternoon", "Good evening", "Good evening",
    ]);
  });

  it("renders the neutral greeting on the server", () => {
    expect(renderToString(<Greeting />)).toBe(`<h1>${SERVER_GREETING}</h1>`);
  });

  it("hydrates the server greeting without a mismatch, then shows the local one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 0, 15, 20, 0) });
    container = document.createElement("div");
    container.innerHTML = renderToString(<Greeting />);
    document.body.appendChild(container);
    const recoverable: unknown[] = [];
    await act(async () => { root = hydrateRoot(container, <Greeting />, { onRecoverableError: (e) => recoverable.push(e) }); });
    expect(recoverable).toStrictEqual([]);
    expect(container.textContent).toBe("Good evening");
  });

  it("shows the local greeting straight away on a client render", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 0, 15, 9, 0) });
    await render(<Greeting />);
    expect(container.textContent).toBe("Good morning");
  });
});
