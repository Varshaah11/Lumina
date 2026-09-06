"use client";

import { useRef, useEffect, useState, Suspense } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { ChatInput } from "@/components/chat/ChatInput";
import { EmptyState } from "@/components/chat/EmptyState";
import { VoiceAssistantOverlay } from "@/components/chat/VoiceAssistantOverlay";
import { useChat } from "@/hooks/useChat";
import { motion, AnimatePresence } from "framer-motion";

function ChatContent() {
  const { messages, isLoading, sendMessage, stopGeneration, regenerateResponse } = useChat();
  const [isVoiceModeOpen, setIsVoiceModeOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);

  const hasDocument = messages.some((m) => m.content.includes("📄 ") || m.content.includes("[Attached Document:"));

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 100;
    isUserScrollingRef.current = !isAtBottom;
  };

  useEffect(() => {
    if (!isUserScrollingRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading]);

  return (
    <div className="flex flex-col h-[calc(100vh-80px)] md:h-[calc(100vh-64px)] relative">
      {/* Voice Assistant Fullscreen Overlay */}
      <VoiceAssistantOverlay
        isOpen={isVoiceModeOpen}
        onClose={() => setIsVoiceModeOpen(false)}
        sendMessage={sendMessage}
        stopGeneration={stopGeneration}
        isLoading={isLoading}
        messages={messages}
        hasDocument={hasDocument}
      />

      {/* Chat Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scroll-smooth pb-4 px-2 md:px-0 no-scrollbar"
      >
        {messages.length === 0 ? (
          <div className="h-full pt-10">
            <EmptyState onActionClick={sendMessage} />
          </div>
        ) : (
          <div className="flex flex-col min-h-full py-6 space-y-2">
            <AnimatePresence initial={false}>
              {messages.map((message) => (
                <ChatBubble
                  key={message.id}
                  message={message}
                  isStreaming={isLoading}
                  onRegenerate={
                    message.role === "assistant" && message.content !== "" && !isLoading
                      ? () => regenerateResponse(message.id)
                      : undefined
                  }
                />
              ))}
            </AnimatePresence>
            <div ref={bottomRef} className="h-4" />
          </div>
        )}
      </div>

      {/* Sticky Input Area */}
      <div className="sticky bottom-0 left-0 right-0 pt-2 bg-gradient-to-t from-black via-black to-transparent">
        <ChatInput
          onSend={sendMessage}
          isLoading={isLoading}
          onStop={stopGeneration}
          onOpenVoiceMode={() => setIsVoiceModeOpen(true)}
        />
      </div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <DashboardLayout>
      <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-500">Loading chat...</div>}>
        <ChatContent />
      </Suspense>
    </DashboardLayout>
  );
}
