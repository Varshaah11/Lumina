"use client";

import { useRef, useEffect, useState, useMemo, Suspense } from "react";
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
  const touchStartYRef = useRef<number | null>(null);

  const hasDocument = messages.some((m) => m.content.includes("📄 ") || m.content.includes("[Attached Document:"));

  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i].id;
      }
    }
    return null;
  }, [messages]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom > 30) {
      isUserScrollingRef.current = true;
    } else {
      isUserScrollingRef.current = false;
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      isUserScrollingRef.current = true;
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartYRef.current !== null) {
      const deltaY = e.touches[0].clientY - touchStartYRef.current;
      if (deltaY > 5) {
        isUserScrollingRef.current = true;
      }
    }
  };

  const handleSendMessage = (content: string, file?: File | null) => {
    isUserScrollingRef.current = false;
    sendMessage(content, file);
  };

  const handleRegenerate = (messageId: string) => {
    isUserScrollingRef.current = false;
    regenerateResponse(messageId);
  };

  useEffect(() => {
    if (!isUserScrollingRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: isLoading ? "auto" : "smooth" });
    }
  }, [messages, isLoading]);

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      {/* Voice Assistant Fullscreen Overlay */}
      <VoiceAssistantOverlay
        isOpen={isVoiceModeOpen}
        onClose={() => setIsVoiceModeOpen(false)}
        sendMessage={handleSendMessage}
        stopGeneration={stopGeneration}
        isLoading={isLoading}
        messages={messages}
        hasDocument={hasDocument}
      />

      {/* Chat Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        className="flex-1 min-h-0 overflow-y-auto scroll-smooth pb-4 px-2 md:px-0 no-scrollbar"
      >
        {messages.length === 0 ? (
          <div className="h-full pt-10">
            <EmptyState onActionClick={handleSendMessage} />
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
                    message.id === lastAssistantMessageId && message.content !== "" && !isLoading
                      ? () => handleRegenerate(message.id)
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
      <div className="shrink-0 pt-2 bg-gradient-to-t from-black via-black to-transparent z-10">
        <ChatInput
          onSend={handleSendMessage}
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
    <DashboardLayout noScroll>
      <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-500">Loading chat...</div>}>
        <ChatContent />
      </Suspense>
    </DashboardLayout>
  );
}
