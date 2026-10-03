import { useState } from "react";
import { Message } from "@/hooks/useChat";
import { Sparkles, AlertCircle } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/useAuth";
import { useMessageSpeech } from "@/hooks/useMessageSpeech";
import { MarkdownContent } from "./MarkdownContent";
import { UserMessageContent } from "./UserMessageContent";
import { AssistantMessageActions, ErrorMessageActions } from "./MessageActions";

export { getPreferredFemaleVoice } from "@/hooks/useMessageSpeech";

/** One chat message: avatar, name/time header, content (plain text for the user, Markdown for the assistant) and actions. */
export function ChatBubble({
  message,
  onRegenerate,
  onRetry,
  isStreaming,
}: {
  message: Message;
  onRegenerate?: () => void;
  onRetry?: () => void;
  isStreaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  const { user } = useAuth();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { isSpeaking, isPendingTTS, handleToggleSpeech } = useMessageSpeech(message.content);

  const copyToClipboard = (text: string, id: string = "msg") => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
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
      <div className={`flex flex-col max-w-[85%] ${isUser ? "items-end" : "items-start"} group`}>
        <div className="flex items-center gap-2 mb-1 px-1">
          <span className="text-sm font-medium text-gray-300">
            {isUser ? user?.name || "You" : isError ? "System Error" : "Lumina"}
          </span>
          <span className="text-xs text-gray-500">
            {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        <div
          className={`px-5 py-4 rounded-2xl relative ${
            isUser
              ? "bg-indigo-500 text-white rounded-tr-sm shadow-[0_0_15px_rgba(99,102,241,0.2)]"
              : isError
              ? "bg-red-500/10 border border-red-500/20 text-red-200 rounded-tl-sm"
              : "bg-white/5 border border-white/10 text-gray-200 rounded-tl-sm shadow-sm"
          }`}
        >
          {isUser ? (
            <UserMessageContent content={message.content} />
          ) : !isError && message.content === "" ? (
            <div className="flex items-center gap-1.5 h-6">
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          ) : (
            <div className="prose prose-invert max-w-none text-sm leading-relaxed overflow-hidden">
              <MarkdownContent
                content={message.content}
                isStreaming={isStreaming}
                copiedId={copiedId}
                onCopy={copyToClipboard}
              />
            </div>
          )}
        </div>

        {/* Assistant Message Actions */}
        {!isUser && !isError && (
          <AssistantMessageActions
            content={message.content}
            copied={copiedId === "msg"}
            isSpeaking={isSpeaking}
            isPendingTTS={isPendingTTS}
            isStreaming={isStreaming}
            onCopy={() => copyToClipboard(message.content)}
            onToggleSpeech={handleToggleSpeech}
            onRegenerate={onRegenerate}
          />
        )}

        {/* Error Message Actions */}
        {isError && (
          <ErrorMessageActions
            copied={copiedId === "msg"}
            onCopy={() => copyToClipboard(message.content)}
            onRetry={onRetry}
          />
        )}
      </div>
    </motion.div>
  );
}
