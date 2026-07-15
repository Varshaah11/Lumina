"use client";

import { useRef, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { ChatBubble, LoadingBubble } from "@/components/chat/ChatBubble";
import { ChatInput } from "@/components/chat/ChatInput";
import { EmptyState } from "@/components/chat/EmptyState";
import { useChat } from "@/hooks/useChat";
import { motion, AnimatePresence } from "framer-motion";

export default function ChatPage() {
  const { messages, isLoading, sendMessage } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <DashboardLayout>
      <div className="flex flex-col h-[calc(100vh-80px)] md:h-[calc(100vh-64px)] relative">
        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto scroll-smooth pb-4 px-2 md:px-0 no-scrollbar">
          {messages.length === 0 ? (
            <div className="h-full pt-10">
              <EmptyState onActionClick={sendMessage} />
            </div>
          ) : (
            <div className="flex flex-col min-h-full py-6 space-y-2">
              <AnimatePresence initial={false}>
                {messages.map((message) => (
                  <ChatBubble key={message.id} message={message} />
                ))}
                {isLoading && (
                  <LoadingBubble key="loading" />
                )}
              </AnimatePresence>
              <div ref={bottomRef} className="h-4" />
            </div>
          )}
        </div>

        {/* Sticky Input Area */}
        <div className="sticky bottom-0 left-0 right-0 pt-2 bg-gradient-to-t from-black via-black to-transparent">
          <ChatInput onSend={sendMessage} isLoading={isLoading} />
        </div>
      </div>
    </DashboardLayout>
  );
}
