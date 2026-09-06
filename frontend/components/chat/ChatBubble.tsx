import { useState, useEffect, useRef } from "react";
import { Message } from "@/hooks/useChat";
import { Sparkles, Copy, Check, RotateCcw, AlertCircle, Volume2, Square } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/useAuth";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { Button } from "@/components/ui/button";
import { MermaidDiagram } from "./MermaidDiagram";
import Cookies from "js-cookie";
import { sanitizeTextForTTS } from "@/lib/speechSanitizer";

let currentAbortController: AbortController | null = null;
let activeStopCallback: (() => void) | null = null;
let currentAudioElement: HTMLAudioElement | null = null;
let currentAudioObjectURL: string | null = null;
let globalRequestId = 0;

function stopActiveSpeech() {
  globalRequestId++;

  if (currentAbortController) {
    try {
      currentAbortController.abort();
    } catch {
      // ignore
    }
    currentAbortController = null;
  }

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore errors when cancelling speech
    }
  }

  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      currentAudioElement.currentTime = 0;
    } catch {
      // ignore
    }
    currentAudioElement = null;
  }

  if (currentAudioObjectURL) {
    try {
      URL.revokeObjectURL(currentAudioObjectURL);
    } catch {
      // ignore
    }
    currentAudioObjectURL = null;
  }

  if (activeStopCallback) {
    const cb = activeStopCallback;
    activeStopCallback = null;
    cb();
  }
}

export function getPreferredFemaleVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return null;
  }

  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return null;

  const preferredFemaleNames = [
    "samantha",
    "zira",
    "jenny",
    "aria",
    "karen",
    "fiona",
    "victoria",
    "veena",
    "google us english",
    "google uk english female",
    "ava",
    "serena",
    "allison",
    "susan",
    "zoe",
    "moira",
    "stephanie",
    "eva",
    "hazel"
  ];

  // Tier 1: Preferred known natural English female voices
  const tier1Voice = voices.find((v) => {
    const isEnglish = v.lang.startsWith("en");
    const nameLower = v.name.toLowerCase();
    return isEnglish && preferredFemaleNames.some((p) => nameLower.includes(p));
  });
  if (tier1Voice) return tier1Voice;

  // Tier 2: Other English voices whose name strongly indicates a female voice
  const tier2Voice = voices.find((v) => {
    const isEnglish = v.lang.startsWith("en");
    const nameLower = v.name.toLowerCase();
    return isEnglish && (nameLower.includes("female") || nameLower.includes("woman"));
  });
  if (tier2Voice) return tier2Voice;

  // Tier 3: Browser/OS default voice if no suitable female English voice is available
  return voices.find((v) => v.default) || voices[0] || null;
}

function getHeadingSlug(children: any, slugTracker: Map<string, number>): string {
  const extractText = (node: any): string => {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(extractText).join("");
    if (node?.props?.children) return extractText(node.props.children);
    return "";
  };

  const text = extractText(children);
  const baseSlug =
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "heading";

  const count = slugTracker.get(baseSlug) || 0;
  slugTracker.set(baseSlug, count + 1);

  return count === 0 ? baseSlug : `${baseSlug}-${count}`;
}

function renderUserMessage(content: string) {
  if (!content) return null;

  // Handle legacy format containing embedded raw extracted text
  if (content.includes("Extracted Content:") && content.includes('"""')) {
    const filenameMatch = content.match(/\[Attached Document:\s*([^\]]+)\]/i);
    const filename = filenameMatch ? filenameMatch[1].trim() : "Attached Document";

    const lastQuoteIndex = content.lastIndexOf('"""');
    const prompt = lastQuoteIndex !== -1 ? content.slice(lastQuoteIndex + 3).trim() : "";

    return (
      <div className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 border border-white/20 text-xs font-medium text-white w-fit shadow-sm">
          <span>📄</span>
          <span>{filename}</span>
        </div>
        {prompt && <div className="whitespace-pre-wrap leading-relaxed text-sm">{prompt}</div>}
      </div>
    );
  }

  // Handle file header format: 📄 filename.pdf\n\nUser prompt
  if (content.startsWith("📄 ")) {
    const parts = content.split("\n\n");
    const filename = parts[0].slice(2).trim();
    const prompt = parts.slice(1).join("\n\n").trim();

    return (
      <div className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 border border-white/20 text-xs font-medium text-white w-fit shadow-sm">
          <span>📄</span>
          <span>{filename}</span>
        </div>
        {prompt && <div className="whitespace-pre-wrap leading-relaxed text-sm">{prompt}</div>}
      </div>
    );
  }

  return <div className="whitespace-pre-wrap leading-relaxed text-sm">{content}</div>;
}

export function ChatBubble({
  message,
  onRegenerate,
  isStreaming,
}: {
  message: Message;
  onRegenerate?: () => void;
  isStreaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  const { user } = useAuth();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPendingTTS, setIsPendingTTS] = useState(false);
  const activeStopCallbackRef = useRef<(() => void) | null>(null);

  const slugTracker = new Map<string, number>();

  const copyToClipboard = (text: string, id: string = "msg") => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
      if (typeof window.speechSynthesis.onvoiceschanged !== "undefined") {
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.getVoices();
        };
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      if (activeStopCallbackRef.current && activeStopCallback === activeStopCallbackRef.current) {
        stopActiveSpeech();
      }
    };
  }, []);

  const fallbackSpeechSynthesis = (
    text: string,
    stopThisSpeech: () => void,
    clearCallback: () => void,
    requestId: number,
    controller: AbortController
  ) => {
    if (requestId !== globalRequestId || controller.signal.aborted) {
      clearCallback();
      return;
    }

    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      clearCallback();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.98;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    const voice = getPreferredFemaleVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = navigator.language || "en-US";
    }

    activeStopCallback = stopThisSpeech;

    utterance.onstart = () => {
      if (requestId !== globalRequestId || controller.signal.aborted) {
        try {
          window.speechSynthesis.cancel();
        } catch {}
        clearCallback();
        return;
      }
      setIsPendingTTS(false);
      setIsSpeaking(true);
    };

    utterance.onend = () => {
      clearCallback();
    };

    utterance.onerror = () => {
      clearCallback();
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      clearCallback();
    }
  };

  const handleToggleSpeech = async () => {
    if (isSpeaking || isPendingTTS) {
      stopActiveSpeech();
      return;
    }

    stopActiveSpeech();

    const cleanText = sanitizeTextForTTS(message.content);
    if (!cleanText.trim()) return;

    const requestId = ++globalRequestId;
    const controller = new AbortController();
    currentAbortController = controller;

    setIsPendingTTS(true);

    const stopThisSpeech = () => {
      setIsSpeaking(false);
      setIsPendingTTS(false);
      if (activeStopCallbackRef.current === stopThisSpeech) {
        activeStopCallbackRef.current = null;
      }
    };

    activeStopCallbackRef.current = stopThisSpeech;
    activeStopCallback = stopThisSpeech;

    const clearCallback = () => {
      setIsSpeaking(false);
      setIsPendingTTS(false);
      if (activeStopCallbackRef.current === stopThisSpeech) {
        activeStopCallbackRef.current = null;
      }
      if (activeStopCallback === stopThisSpeech) {
        activeStopCallback = null;
      }
      if (currentAbortController === controller) {
        currentAbortController = null;
      }
    };

    // 1. Try Kokoro backend TTS
    try {
      const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const token = Cookies.get("token");

      const headers: HeadersInit = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const response = await fetch(`${API_BASE_URL}/tts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: cleanText }),
        signal: controller.signal,
      });

      if (requestId !== globalRequestId || controller.signal.aborted) {
        return;
      }

      if (!response.ok) {
        throw new Error(`Kokoro TTS backend error: ${response.status}`);
      }

      const blob = await response.blob();

      if (requestId !== globalRequestId || controller.signal.aborted) {
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      currentAudioElement = audio;
      currentAudioObjectURL = objectUrl;

      audio.onplay = () => {
        if (requestId !== globalRequestId || controller.signal.aborted) {
          try {
            audio.pause();
          } catch {}
          return;
        }
        setIsPendingTTS(false);
        setIsSpeaking(true);
      };

      audio.onended = () => {
        clearCallback();
        if (currentAudioObjectURL === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          currentAudioObjectURL = null;
        }
        if (currentAudioElement === audio) {
          currentAudioElement = null;
        }
      };

      audio.onerror = () => {
        clearCallback();
        if (currentAudioObjectURL === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          currentAudioObjectURL = null;
        }
        if (currentAudioElement === audio) {
          currentAudioElement = null;
        }
        if (requestId === globalRequestId && !controller.signal.aborted) {
          fallbackSpeechSynthesis(cleanText, stopThisSpeech, clearCallback, requestId, controller);
        }
      };

      await audio.play();
      return;
    } catch (err: any) {
      if (err?.name === "AbortError" || requestId !== globalRequestId || controller.signal.aborted) {
        clearCallback();
        return;
      }
      if (requestId === globalRequestId && !controller.signal.aborted) {
        fallbackSpeechSynthesis(cleanText, stopThisSpeech, clearCallback, requestId, controller);
      } else {
        clearCallback();
      }
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-4 w-full max-w-4xl mx-auto py-6 ${isUser ? "flex-row-reverse" : "flex-row"}`}
    >
      {/* Avatar */}
      <div
        className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center shadow-md ${
          isUser
            ? "bg-gradient-to-br from-indigo-500 to-purple-500"
            : isError
            ? "bg-red-500/20 border border-red-500/50 text-red-400"
            : "bg-white/10 border border-white/20"
        }`}
      >
        {isUser ? (
          <span className="text-xs font-bold text-white">
            {user?.name?.charAt(0).toUpperCase() || "U"}
          </span>
        ) : isError ? (
          <AlertCircle className="w-4 h-4" />
        ) : (
          <Sparkles className="w-4 h-4 text-indigo-400" />
        )}
      </div>

      {/* Message Content */}
      <div className={`flex flex-col max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
        <div className="flex items-center gap-2 mb-1 px-1">
          <span className="text-sm font-medium text-gray-300">
            {isUser ? user?.name || "You" : isError ? "System Error" : "Lumina"}
          </span>
          <span className="text-xs text-gray-500">
            {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        <div
          className={`px-5 py-4 rounded-2xl relative group ${
            isUser
              ? "bg-indigo-500 text-white rounded-tr-sm shadow-[0_0_15px_rgba(99,102,241,0.2)]"
              : isError
              ? "bg-red-500/10 border border-red-500/20 text-red-200 rounded-tl-sm"
              : "bg-white/5 border border-white/10 text-gray-200 rounded-tl-sm shadow-sm"
          }`}
        >
          {isUser ? (
            renderUserMessage(message.content)
          ) : !isError && message.content === "" ? (
            <div className="flex items-center gap-1.5 h-6">
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          ) : (
            <div className="prose prose-invert max-w-none text-sm leading-relaxed overflow-hidden">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  code({ node, inline, className, children, ...props }: any) {
                    const match = /language-(\w+)/.exec(className || "");
                    const lang = match ? match[1].toLowerCase() : "";
                    const codeText = String(children).replace(/\n$/, "");
                    const id = Math.random().toString(36).substring(7);

                    if (lang === "mermaid") {
                      return <MermaidDiagram chart={codeText} isStreaming={isStreaming} />;
                    }

                    const isBlock = !inline && (match || codeText.includes("\n"));

                    return isBlock ? (
                      <div className="relative group/code my-4 rounded-xl overflow-hidden border border-white/10 bg-[#18181b] shadow-md">
                        <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10 text-xs font-mono text-gray-400">
                          <span className="font-semibold text-indigo-400 uppercase tracking-wider">
                            {match ? match[1] : "code"}
                          </span>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(codeText, id)}
                            className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors cursor-pointer"
                            title="Copy code"
                          >
                            {copiedId === id ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                <span className="text-emerald-400 font-sans font-medium">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span className="font-sans font-medium">Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                        <SyntaxHighlighter
                          {...props}
                          style={vscDarkPlus}
                          language={match ? match[1] : "text"}
                          PreTag="div"
                          customStyle={{ margin: 0, padding: "1rem", background: "transparent", fontSize: "0.85rem" }}
                        >
                          {codeText}
                        </SyntaxHighlighter>
                      </div>
                    ) : (
                      <code
                        {...props}
                        className="bg-white/10 px-1.5 py-0.5 rounded-md text-indigo-300 font-mono text-xs border border-white/10"
                      >
                        {children}
                      </code>
                    );
                  },
                  h1({ children }: any) {
                    const id = getHeadingSlug(children, slugTracker);
                    return (
                      <h1 id={id} className="text-2xl font-bold text-white mt-6 mb-3 pb-1.5 border-b border-white/10 scroll-mt-4">
                        {children}
                      </h1>
                    );
                  },
                  h2({ children }: any) {
                    const id = getHeadingSlug(children, slugTracker);
                    return (
                      <h2 id={id} className="text-xl font-bold text-white mt-5 mb-2.5 pb-1 border-b border-white/10 scroll-mt-4">
                        {children}
                      </h2>
                    );
                  },
                  h3({ children }: any) {
                    const id = getHeadingSlug(children, slugTracker);
                    return (
                      <h3 id={id} className="text-lg font-semibold text-white mt-4 mb-2 scroll-mt-4">
                        {children}
                      </h3>
                    );
                  },
                  h4({ children }: any) {
                    const id = getHeadingSlug(children, slugTracker);
                    return (
                      <h4 id={id} className="text-base font-semibold text-gray-200 mt-3 mb-1.5 scroll-mt-4">
                        {children}
                      </h4>
                    );
                  },
                  h5({ children }: any) {
                    const id = getHeadingSlug(children, slugTracker);
                    return (
                      <h5 id={id} className="text-sm font-semibold text-gray-300 mt-2 mb-1 scroll-mt-4">
                        {children}
                      </h5>
                    );
                  },
                  h6({ children }: any) {
                    const id = getHeadingSlug(children, slugTracker);
                    return (
                      <h6 id={id} className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-2 mb-1 scroll-mt-4">
                        {children}
                      </h6>
                    );
                  },
                  p({ children }: any) {
                    return <p className="my-2.5 leading-relaxed text-gray-200 text-sm">{children}</p>;
                  },
                  ul({ children }: any) {
                    return <ul className="list-disc list-outside ml-5 space-y-1.5 my-3 text-gray-200 text-sm">{children}</ul>;
                  },
                  ol({ children }: any) {
                    return <ol className="list-decimal list-outside ml-5 space-y-1.5 my-3 text-gray-200 text-sm">{children}</ol>;
                  },
                  li({ children }: any) {
                    return <li className="text-sm text-gray-200 leading-relaxed">{children}</li>;
                  },
                  blockquote({ children }: any) {
                    return (
                      <blockquote className="border-l-4 border-indigo-500 bg-indigo-500/10 px-4 py-3 my-4 rounded-r-xl text-gray-300 italic text-sm">
                        {children}
                      </blockquote>
                    );
                  },
                  table({ children }: any) {
                    return (
                      <div className="overflow-x-auto my-4 rounded-xl border border-white/10 bg-white/[0.02] shadow-sm">
                        <table className="w-full text-left text-sm text-gray-300 border-collapse">{children}</table>
                      </div>
                    );
                  },
                  thead({ children }: any) {
                    return <thead className="bg-white/5 border-b border-white/10 text-xs font-semibold text-gray-300 uppercase tracking-wider">{children}</thead>;
                  },
                  tbody({ children }: any) {
                    return <tbody className="divide-y divide-white/5">{children}</tbody>;
                  },
                  tr({ children }: any) {
                    return <tr className="hover:bg-white/[0.02] transition-colors">{children}</tr>;
                  },
                  th({ children }: any) {
                    return <th className="px-4 py-3 text-left text-xs font-semibold text-gray-200 uppercase tracking-wider">{children}</th>;
                  },
                  td({ children }: any) {
                    return <td className="px-4 py-3 text-sm text-gray-300 whitespace-normal">{children}</td>;
                  },
                  a({ href, children }: any) {
                    const isExternal = href?.startsWith("http://") || href?.startsWith("https://");
                    return (
                      <a
                        href={href}
                        target={isExternal ? "_blank" : undefined}
                        rel={isExternal ? "noopener noreferrer" : undefined}
                        className="text-indigo-400 hover:text-indigo-300 underline underline-offset-4 decoration-indigo-500/50 hover:decoration-indigo-400 transition-colors font-medium"
                      >
                        {children}
                      </a>
                    );
                  },
                  hr() {
                    return <hr className="my-6 border-t border-white/10" />;
                  },
                  del({ children }: any) {
                    return <del className="line-through text-gray-400">{children}</del>;
                  },
                  input({ node, ...props }: any) {
                    if (props.type === "checkbox") {
                      return (
                        <input
                          {...props}
                          disabled
                          className="mr-2 rounded border-white/20 bg-white/10 text-indigo-500 focus:ring-0 focus:ring-offset-0 cursor-default accent-indigo-500"
                        />
                      );
                    }
                    return <input {...props} />;
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}

          {/* Assistant Message Actions */}
          {!isUser && !isError && (
            <div className="absolute -bottom-10 left-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg"
                onClick={() => copyToClipboard(message.content)}
                title="Copy message"
              >
                {copiedId === "msg" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </Button>

              {!isStreaming && message.content.trim() !== "" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 rounded-lg transition-all ${
                    isSpeaking || isPendingTTS
                      ? "text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20"
                      : "text-gray-400 hover:text-white hover:bg-white/10"
                  }`}
                  onClick={handleToggleSpeech}
                  title={isSpeaking || isPendingTTS ? "Stop speaking" : "Speak response"}
                >
                  {isSpeaking || isPendingTTS ? (
                    <Square className="w-3.5 h-3.5 fill-current animate-pulse text-red-400" />
                  ) : (
                    <Volume2 className="w-4 h-4" />
                  )}
                </Button>
              )}

              {onRegenerate && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg"
                  onClick={onRegenerate}
                  title="Regenerate response"
                >
                  <RotateCcw className="w-4 h-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
