import { useEffect, useRef, useCallback } from "react";
import { VoiceOrb } from "./VoiceOrb";
import { useVoiceConversation, VoiceState } from "@/hooks/useVoiceConversation";
import { Message } from "@/hooks/useChat";
import { Button } from "@/components/ui/button";
import { X, Mic, MicOff, Square, RefreshCw, ArrowLeft, Volume2, Sparkles, Check, Copy } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";

interface VoiceAssistantOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  sendMessage: (content: string, file?: File | null, isVoice?: boolean) => Promise<void> | void;
  stopGeneration: () => void;
  isLoading: boolean;
  messages: Message[];
  hasDocument?: boolean;
  enableWakeWord?: boolean;
  onOpenVoiceMode?: () => void;
}

export function VoiceAssistantOverlay({
  isOpen,
  onClose,
  sendMessage,
  stopGeneration,
  isLoading,
  messages,
  hasDocument = false,
  enableWakeWord = true,
  onOpenVoiceMode,
}: VoiceAssistantOverlayProps) {
  const {
    voiceState,
    transcript,
    actionFeedback,
    isLoopEnabled,
    errorMessage,
    startListening,
    handleStop,
    toggleLoop,
    testTTSAudioPlayback,
    exitVoiceMode,
  } = useVoiceConversation({
    sendMessage,
    stopGeneration,
    isLoading,
    messages,
    isOpen,
    hasDocument,
    enableWakeWord,
    onOpenVoiceMode,
  });

  const handleExit = useCallback(() => {
    exitVoiceMode();
    onClose();
  }, [exitVoiceMode, onClose]);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll conversation transcript to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, transcript]);

  if (!isOpen) return null;

  // Filter and clean message text for display
  const cleanDisplayContent = (content: string) => {
    if (!content) return "";
    if (content.startsWith("📄 ")) {
      const parts = content.split("\n\n");
      return parts.slice(1).join("\n\n").trim() || "Attached document query";
    }
    if (content.includes("Extracted Content:") && content.includes('"""')) {
      const lastQuoteIndex = content.lastIndexOf('"""');
      return lastQuoteIndex !== -1 ? content.slice(lastQuoteIndex + 3).trim() : content;
    }
    return content;
  };

  const recentMessages = messages.filter((m) => m.role !== "error").slice(-6);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        className="fixed inset-0 z-50 flex flex-col items-center justify-between p-4 sm:p-6 bg-black/90 backdrop-blur-2xl text-white select-none overflow-hidden"
      >
        {/* Top Bar Navigation & Actions */}
        <div className="w-full max-w-4xl flex items-center justify-between z-10 pt-2">
          <Button
            variant="ghost"
            onClick={handleExit}
            className="flex items-center gap-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-xl px-3 py-2 text-sm font-medium transition-all"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Text View</span>
          </Button>

          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-3.5 py-1 rounded-full flex items-center gap-1.5 shadow-sm">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Lumina Assistant</span>
            </span>

            {/* Temporary Explicit Test TTS Audio Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={testTTSAudioPlayback}
              className="bg-emerald-500/20 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 text-xs font-semibold rounded-full px-3 py-1 flex items-center gap-1.5"
              title="Test direct /tts fetch and HTML5 Audio playback from user click"
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span>🔊 Test Audio Playback</span>
            </Button>
          </div>

          <Button
            variant="ghost"
            size="icon"
            onClick={handleExit}
            className="text-gray-400 hover:text-white hover:bg-white/10 rounded-xl h-10 w-10"
            title="Close Voice Mode"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Central Orb & State Display */}
        <div className="flex-1 flex flex-col items-center justify-center my-2 relative w-full max-w-2xl overflow-hidden">
          {/* Action Feedback Toast */}
          <AnimatePresence>
            {actionFeedback && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                className="mb-4 px-4 py-2 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-semibold tracking-wide shadow-lg flex items-center gap-2 backdrop-blur-md"
              >
                <span>{actionFeedback}</span>
              </motion.div>
            )}
          </AnimatePresence>

          <VoiceOrb
            state={voiceState}
            onClick={() => {
              if (voiceState === "LISTENING") {
                handleStop();
              } else {
                startListening();
              }
            }}
          />

          {/* Status Headline */}
          <div className="mt-6 flex flex-col items-center text-center max-w-md px-4 min-h-[50px]">
            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white mb-1">
              {voiceState === "LISTENING" && "Lumina is Listening..."}
              {voiceState === "THINKING" && "Lumina is Thinking... (Say 'Stop' to cancel)"}
              {voiceState === "SPEAKING" && "Lumina is Speaking... (Say 'Stop' to interrupt)"}
              {voiceState === "ACTION" && (actionFeedback || "Executing Action...")}
              {voiceState === "IDLE" && "Tap the Orb or say 'Lumina' to Speak"}
              {voiceState === "ERROR" && "Voice Error"}
            </h2>

            <p className="text-xs sm:text-sm text-gray-400">
              {voiceState === "LISTENING" && "Speak naturally into your microphone."}
              {voiceState === "THINKING" && "Processing intent and response..."}
              {voiceState === "SPEAKING" && "Interrupt anytime by saying 'stop' or 'Lumina stop'."}
              {voiceState === "IDLE" && "Continuous conversation paused."}
              {voiceState === "ERROR" && (errorMessage || "Check microphone settings.")}
            </p>
          </div>

          {/* Multi-Turn Voice Conversation Transcript Stream */}
          <div
            ref={scrollRef}
            className="mt-4 w-full max-w-xl max-h-[45vh] overflow-y-auto px-4 space-y-3 no-scrollbar"
          >
            {recentMessages.map((msg) => (
              <div
                key={msg.id}
                className={`p-4 rounded-2xl text-xs sm:text-sm leading-relaxed max-w-[95%] backdrop-blur-xl border shadow-sm ${
                  msg.role === "user"
                    ? "ml-auto bg-indigo-500/20 border-indigo-500/30 text-indigo-100 rounded-tr-sm"
                    : "mr-auto bg-white/5 border-white/10 text-gray-200 rounded-tl-sm"
                }`}
              >
                <span className="text-[10px] font-bold block mb-1 uppercase tracking-wider opacity-60">
                  {msg.role === "user" ? "You" : "Lumina"}
                </span>

                {msg.role === "user" ? (
                  <div className="whitespace-pre-wrap leading-relaxed text-indigo-100">
                    {cleanDisplayContent(msg.content)}
                  </div>
                ) : (
                  <div className="prose prose-invert max-w-none text-xs sm:text-sm leading-relaxed overflow-hidden">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={{
                        code({ node, inline, className, children, ...props }: any) {
                          const match = /language-(\w+)/.exec(className || "");
                          const codeText = String(children).replace(/\n$/, "");
                          const isBlock = !inline && (match || codeText.includes("\n"));

                          return isBlock ? (
                            <div className="relative group/code my-3 rounded-xl overflow-hidden border border-white/10 bg-[#18181b] shadow-md">
                              <div className="flex items-center justify-between px-3 py-1.5 bg-white/5 border-b border-white/10 text-[10px] font-mono text-gray-400">
                                <span className="font-semibold text-indigo-400 uppercase tracking-wider">
                                  {match ? match[1] : "code"}
                                </span>
                              </div>
                              <SyntaxHighlighter
                                {...props}
                                style={vscDarkPlus}
                                language={match ? match[1] : "text"}
                                PreTag="div"
                                customStyle={{ margin: 0, padding: "0.75rem", background: "transparent", fontSize: "0.8rem" }}
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
                          return <h1 className="text-base sm:text-lg font-bold text-white mt-4 mb-2 pb-1 border-b border-white/10">{children}</h1>;
                        },
                        h2({ children }: any) {
                          return <h2 className="text-sm sm:text-base font-bold text-white mt-3 mb-1.5 pb-1 border-b border-white/10">{children}</h2>;
                        },
                        h3({ children }: any) {
                          return <h3 className="text-xs sm:text-sm font-semibold text-white mt-2.5 mb-1">{children}</h3>;
                        },
                        p({ children }: any) {
                          return <p className="my-1.5 leading-relaxed text-gray-200">{children}</p>;
                        },
                        ul({ children }: any) {
                          return <ul className="list-disc list-outside ml-4 space-y-1 my-2 text-gray-200">{children}</ul>;
                        },
                        ol({ children }: any) {
                          return <ol className="list-decimal list-outside ml-4 space-y-1 my-2 text-gray-200">{children}</ol>;
                        },
                        li({ children }: any) {
                          return <li className="text-xs sm:text-sm text-gray-200 leading-relaxed">{children}</li>;
                        },
                        blockquote({ children }: any) {
                          return (
                            <blockquote className="border-l-4 border-indigo-500 bg-indigo-500/10 px-3 py-2 my-2 rounded-r-xl text-gray-300 italic text-xs">
                              {children}
                            </blockquote>
                          );
                        },
                        table({ children }: any) {
                          return (
                            <div className="overflow-x-auto my-2 rounded-xl border border-white/10 bg-white/[0.02]">
                              <table className="w-full text-left text-xs text-gray-300 border-collapse">{children}</table>
                            </div>
                          );
                        },
                        th({ children }: any) {
                          return <th className="px-3 py-2 text-left text-[10px] font-semibold text-gray-200 uppercase tracking-wider bg-white/5 border-b border-white/10">{children}</th>;
                        },
                        td({ children }: any) {
                          return <td className="px-3 py-2 text-xs text-gray-300 border-b border-white/5">{children}</td>;
                        },
                        hr() {
                          return <hr className="my-3 border-t border-white/10" />;
                        },
                      }}
                    >
                      {cleanDisplayContent(msg.content)}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            ))}

            {/* Live Interim Transcript Bubble (Active ONLY during LISTENING state before submission) */}
            {voiceState === "LISTENING" && transcript && (
              <div className="ml-auto p-3 rounded-2xl bg-indigo-500/30 border border-indigo-500/50 text-indigo-100 text-xs sm:text-sm italic max-w-[90%] rounded-tr-sm shadow-md animate-pulse">
                <span className="text-[10px] font-bold block mb-1 uppercase tracking-wider text-indigo-300">
                  You (Speaking...)
                </span>
                <p>&quot;{transcript}&quot;</p>
              </div>
            )}
          </div>
        </div>

        {/* Bottom Voice Control Toolbar */}
        <div className="w-full max-w-xl flex items-center justify-between gap-4 p-4 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-2xl shadow-2xl z-10 mb-2">
          {/* Continuous Loop Toggle */}
          <button
            type="button"
            onClick={toggleLoop}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition-all ${
              isLoopEnabled
                ? "bg-indigo-500/20 border border-indigo-500/30 text-indigo-300"
                : "bg-white/5 border border-white/10 text-gray-400 hover:text-white"
            }`}
            title="Auto-resume microphone after Lumina speaks"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoopEnabled ? "text-indigo-400" : ""}`} />
            <span>Continuous Loop: {isLoopEnabled ? "ON" : "OFF"}</span>
          </button>

          {/* Center Mic Action Button */}
          <div className="flex items-center gap-3">
            {voiceState === "LISTENING" ? (
              <Button
                onClick={handleStop}
                variant="destructive"
                size="icon"
                className="h-12 w-12 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white shadow-lg shadow-rose-600/30 transition-all"
                title="Pause listening"
              >
                <MicOff className="w-5 h-5" />
              </Button>
            ) : (
              <Button
                onClick={startListening}
                className="h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 hover:scale-105 transition-all"
                title="Start listening"
              >
                <Mic className="w-5 h-5" />
              </Button>
            )}

            {/* Stop Abort Button */}
            {(voiceState === "THINKING" || voiceState === "SPEAKING") && (
              <Button
                onClick={handleStop}
                variant="destructive"
                size="icon"
                className="h-12 w-12 rounded-2xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-400 shadow-lg transition-all"
                title="Stop generation and speech"
              >
                <Square className="w-5 h-5 fill-current" />
              </Button>
            )}
          </div>

          {/* Quick Exit to Chat */}
          <Button
            variant="ghost"
            onClick={handleExit}
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            Exit Voice Mode
          </Button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
