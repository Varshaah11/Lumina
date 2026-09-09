"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useChat } from "@/hooks/useChat";
import { chatService } from "@/services/chat";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { VoiceOrb } from "@/components/chat/VoiceOrb";
import { VoiceAssistantOverlay } from "@/components/chat/VoiceAssistantOverlay";
import { motion } from "framer-motion";
import { Mic, MessageSquarePlus, FileUp, GraduationCap, Sparkles, MessageSquare, ArrowRight, FileText, NotebookPen, Lightbulb, Target } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

function DashboardContent() {
  const router = useRouter();
  const { user, isLoading: isAuthLoading } = useAuth();
  const { messages, isLoading: isChatLoading, sendMessage, stopGeneration } = useChat();

  const [isVoiceModeOpen, setIsVoiceModeOpen] = useState(false);
  const [isWakeWordEnabled, setIsWakeWordEnabled] = useState(true);
  const [recentChats, setRecentChats] = useState<any[]>([]);
  const [isChatsLoading, setIsChatsLoading] = useState(true);

  // Time-based assistant greeting
  const [greeting, setGreeting] = useState("Good day");

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour < 12) setGreeting("Good morning");
    else if (hour < 18) setGreeting("Good afternoon");
    else setGreeting("Good evening");
  }, []);

  // Fetch real recent user chats
  useEffect(() => {
    chatService
      .getChats()
      .then((data) => {
        if (Array.isArray(data)) {
          setRecentChats(data.slice(0, 4));
        }
      })
      .catch(console.error)
      .finally(() => setIsChatsLoading(false));
  }, []);

  const formatRelativeTime = (dateStr?: string) => {
    if (!dateStr) return "";
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / (1000 * 60));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffMins < 5) return "Just now";
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays === 1) return "Yesterday";
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  };

  const handleDocumentQuickAction = (promptText: string) => {
    router.push(`/chat?action=upload&prompt=${encodeURIComponent(promptText)}`);
  };

  return (
    <DashboardLayout>
      {/* Voice Assistant Fullscreen Overlay */}
      <VoiceAssistantOverlay
        isOpen={isVoiceModeOpen}
        onClose={() => setIsVoiceModeOpen(false)}
        sendMessage={sendMessage}
        stopGeneration={stopGeneration}
        isLoading={isChatLoading}
        messages={messages}
        enableWakeWord={isWakeWordEnabled}
        onOpenVoiceMode={() => setIsVoiceModeOpen(true)}
      />

      <div className="max-w-5xl mx-auto pb-12 space-y-10">
        {/* Main Hero & Lumina Voice Orb Centerpiece */}
        <section className="relative flex flex-col items-center justify-center pt-6 pb-8 text-center rounded-3xl bg-gradient-to-b from-white/[0.04] to-transparent border border-white/10 backdrop-blur-2xl p-5 sm:p-8 md:p-10 shadow-2xl overflow-hidden">
          {/* Ambient Background Glow */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-500/15 rounded-full blur-[100px] pointer-events-none" />

          {isAuthLoading ? (
            <div className="space-y-3 flex flex-col items-center mb-6">
              <Skeleton className="h-10 w-64 bg-white/10" />
              <Skeleton className="h-5 w-40 bg-white/10" />
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-2 mb-6"
            >
              <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight text-white">
                {greeting}, <span className="text-indigo-400">{user?.name || "Explorer"}</span>
              </h1>
              <p className="text-gray-400 text-base sm:text-lg font-medium">
                How can I help you today?
              </p>
            </motion.div>
          )}

          {/* Central Voice Orb */}
          <div className="my-4 relative z-10">
            <VoiceOrb state="IDLE" onClick={() => setIsVoiceModeOpen(true)} />
          </div>

          {/* Orb Subtitle & Primary Start Action */}
          <div className="mt-4 flex flex-col items-center space-y-4 z-10">
            <p className="text-xs sm:text-sm font-medium text-gray-400 uppercase tracking-widest">
              Say something or choose an action
            </p>

            <Button
              onClick={() => setIsVoiceModeOpen(true)}
              className="bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 hover:from-indigo-600 hover:to-pink-600 text-white font-semibold text-base sm:text-lg px-8 py-6 rounded-2xl shadow-xl shadow-indigo-500/25 hover:scale-105 active:scale-95 transition-all flex items-center gap-3 cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              <Mic className="w-6 h-6 animate-pulse" />
              <span>Start Talking</span>
            </Button>

            {/* Subtle Hands-Free Wake Word Indicator & Toggle */}
            <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-gray-400 backdrop-blur-md">
              <span className={`w-2 h-2 rounded-full ${isWakeWordEnabled ? "bg-emerald-400 animate-pulse" : "bg-gray-500"}`} />
              <span>Wake word &quot;Lumina&quot;: {isWakeWordEnabled ? "Listening..." : "OFF"}</span>
              <button
                type="button"
                onClick={() => setIsWakeWordEnabled((prev) => !prev)}
                aria-label={isWakeWordEnabled ? "Disable Lumina hands-free wake word" : "Enable Lumina hands-free wake word"}
                className="ml-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded px-1"
              >
                {isWakeWordEnabled ? "Disable" : "Enable"}
              </button>
            </div>
          </div>
        </section>

        {/* Quick Actions Grid */}
        <section className="space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400 px-1">
            Quick Actions
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Action 1: Start Talking */}
            <motion.div
              role="button"
              tabIndex={0}
              aria-label="Start Talking: Continuous voice conversation loop"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              onClick={() => setIsVoiceModeOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setIsVoiceModeOpen(true);
                }
              }}
              className="group p-5 rounded-2xl bg-white/5 border border-white/10 hover:border-indigo-500/40 hover:bg-white/[0.08] active:scale-[0.98] transition-all cursor-pointer shadow-sm flex flex-col justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/80"
            >
              <div className="w-11 h-11 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Mic className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-base mb-1 group-hover:text-indigo-300 transition-colors">
                  Start Talking
                </h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Continuous voice conversation loop.
                </p>
              </div>
            </motion.div>

            {/* Action 2: New Chat */}
            <motion.div
              role="button"
              tabIndex={0}
              aria-label="New Chat: Start a fresh conversation"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              onClick={() => {
                router.push("/chat");
                window.dispatchEvent(new Event("new-chat"));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push("/chat");
                  window.dispatchEvent(new Event("new-chat"));
                }
              }}
              className="group p-5 rounded-2xl bg-white/5 border border-white/10 hover:border-purple-500/40 hover:bg-white/[0.08] active:scale-[0.98] transition-all cursor-pointer shadow-sm flex flex-col justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/80"
            >
              <div className="w-11 h-11 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <MessageSquarePlus className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-base mb-1 group-hover:text-purple-300 transition-colors">
                  New Chat
                </h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Start a fresh conversation.
                </p>
              </div>
            </motion.div>

            {/* Action 3: Upload Document */}
            <motion.div
              role="button"
              tabIndex={0}
              aria-label="Upload Document: Analyze PDF, DOCX, TXT, or MD"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              onClick={() => router.push("/chat?action=upload")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push("/chat?action=upload");
                }
              }}
              className="group p-5 rounded-2xl bg-white/5 border border-white/10 hover:border-cyan-500/40 hover:bg-white/[0.08] active:scale-[0.98] transition-all cursor-pointer shadow-sm flex flex-col justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/80"
            >
              <div className="w-11 h-11 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <FileUp className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-base mb-1 group-hover:text-cyan-300 transition-colors">
                  Upload Document
                </h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Analyze PDF, DOCX, TXT, or MD.
                </p>
              </div>
            </motion.div>

            {/* Action 4: Study with Lumina */}
            <motion.div
              role="button"
              tabIndex={0}
              aria-label="Study with Lumina: Notes, quizzes, and explanations"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              onClick={() =>
                router.push(
                  `/chat?prompt=${encodeURIComponent(
                    "Create exam-ready study notes and quiz me on a topic."
                  )}`
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(
                    `/chat?prompt=${encodeURIComponent(
                      "Create exam-ready study notes and quiz me on a topic."
                    )}`
                  );
                }
              }}
              className="group p-5 rounded-2xl bg-white/5 border border-white/10 hover:border-amber-500/40 hover:bg-white/[0.08] active:scale-[0.98] transition-all cursor-pointer shadow-sm flex flex-col justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80"
            >
              <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <GraduationCap className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-base mb-1 group-hover:text-amber-300 transition-colors">
                  Study with Lumina
                </h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Notes, quizzes, and explanations.
                </p>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Document Intelligence Section */}
        <section className="p-5 sm:p-8 rounded-3xl bg-white/5 border border-white/10 backdrop-blur-xl shadow-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <FileText className="w-5 h-5 text-indigo-400" />
                Work with a document
              </h2>
              <p className="text-xs sm:text-sm text-gray-400 mt-1">
                Upload a document and ask Lumina to summarize, explain, create notes, or quiz you.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => router.push("/chat?action=upload")}
              className="group border border-white/15 bg-white/10
              text-indigo-300
              hover:bg-indigo-600/30 hover:border-indigo-500/40 hover:text-white
              text-sm font-medium shrink-0 self-start sm:self-auto
              active:scale-95 transition-all shadow-sm hover:shadow-indigo-500/10
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400
              cursor-pointer"
            >
              <FileUp className="w-3.5 h-3.5 mr-0.5 text-indigo-300 group-hover:text-white transition-colors" />
              Choose File
            </Button>
          </div>

          {/* Quick Action Badges */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2">
            <button
              type="button"
              aria-label="Summarize document in 5 key points"
              onClick={() => handleDocumentQuickAction("Summarize this document in 5 key points.")}
              className="px-4 py-3 rounded-xl bg-white/5 hover:bg-indigo-500/20 border border-white/10 hover:border-indigo-500/30 text-indigo-200 hover:text-white text-sm font-medium transition-all text-center cursor-pointer shadow-sm hover:shadow-indigo-500/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4 shrink-0" />
              <span>Summarize</span>
            </button>

            <button
              type="button"
              aria-label="Create exam-ready study notes from document"
              onClick={() =>
                handleDocumentQuickAction("Create exam-ready study notes from this document.")
              }
              className="px-4 py-3 rounded-xl bg-white/5 hover:bg-indigo-500/20 border border-white/10 hover:border-indigo-500/30 text-indigo-200 hover:text-white text-sm font-medium transition-all text-center cursor-pointer shadow-sm hover:shadow-indigo-500/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 flex items-center justify-center gap-2"
            >
              <NotebookPen className="w-4 h-4 shrink-0" />
              <span>Make Notes</span>
            </button>

            <button
              type="button"
              aria-label="Explain contents of document like a beginner"
              onClick={() =>
                handleDocumentQuickAction(
                  "Explain the contents of this document like I am a beginner."
                )
              }
              className="px-4 py-3 rounded-xl bg-white/5 hover:bg-indigo-500/20 border border-white/10 hover:border-indigo-500/30 text-indigo-200 hover:text-white text-sm font-medium transition-all text-center cursor-pointer shadow-sm hover:shadow-indigo-500/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 flex items-center justify-center gap-2"
            >
              <Lightbulb className="w-4 h-4 shrink-0" />
              <span>Explain</span>
            </button>

            <button
              type="button"
              aria-label="Quiz me on this document with 5 questions"
              onClick={() =>
                handleDocumentQuickAction(
                  "Quiz me on this document with 5 questions. Ask one question at a time."
                )
              }
              className="px-4 py-3 rounded-xl bg-white/5 hover:bg-indigo-500/20 border border-white/10 hover:border-indigo-500/30 text-indigo-200 hover:text-white text-sm font-medium transition-all text-center cursor-pointer shadow-sm hover:shadow-indigo-500/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 flex items-center justify-center gap-2"
            >
              <Target className="w-4 h-4 shrink-0" />
              <span>Quiz Me</span>
            </button>
          </div>
        </section>

        {/* Real Recent Conversations */}
        <section className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400">
              Recent Conversations
            </h2>
            <button
              type="button"
              onClick={() => router.push("/history")}
              aria-label="View all chat history"
              className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded-lg px-2 py-1"
            >
              <span>View All</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {isChatsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full rounded-2xl bg-white/5" />
              <Skeleton className="h-16 w-full rounded-2xl bg-white/5" />
            </div>
          ) : recentChats.length === 0 ? (
            <div className="p-8 rounded-2xl bg-white/5 border border-white/10 text-center space-y-3">
              <p className="text-sm font-medium text-gray-300">No conversations yet.</p>
              <p className="text-xs text-gray-500">Start a conversation with Lumina.</p>
              <Button
                onClick={() => {
                  router.push("/chat");
                  window.dispatchEvent(new Event("new-chat"));
                }}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-4 py-2 rounded-xl mt-2 active:scale-95 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                Start Chat
              </Button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {recentChats.map((chat) => (
                <motion.div
                  key={chat.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open conversation: ${chat.title}`}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  onClick={() => router.push(`/chat?chatId=${chat.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/chat?chatId=${chat.id}`);
                    }
                  }}
                  className="p-4 rounded-2xl bg-white/5 border border-white/10 hover:border-indigo-500/30 hover:bg-white/[0.08] active:scale-[0.99] transition-all cursor-pointer flex items-center justify-between group shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <div className="flex items-center gap-3.5 min-w-0 flex-1">
                    <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 group-hover:bg-indigo-500 group-hover:text-white transition-colors shrink-0">
                      <MessageSquare className="w-4 h-4" />
                    </div>
                    <span className="text-gray-200 group-hover:text-white font-medium text-sm truncate">
                      {chat.title}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500 shrink-0 ml-4 font-medium">
                    {formatRelativeTime(chat.updated_at || chat.created_at)}
                  </span>
                </motion.div>
              ))}
            </div>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[60vh] text-gray-500">Loading dashboard...</div>}>
      <DashboardContent />
    </Suspense>
  );
}
