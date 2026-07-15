import { Message } from "@/hooks/useChat";
import { Sparkles, User as UserIcon } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/useAuth";

export function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const { user } = useAuth();

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-4 w-full max-w-4xl mx-auto py-6 ${isUser ? "flex-row-reverse" : "flex-row"}`}
    >
      {/* Avatar */}
      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
        isUser 
          ? "bg-gradient-to-br from-indigo-500 to-purple-500" 
          : "bg-white/10 border border-white/20"
      }`}>
        {isUser ? (
          <span className="text-xs font-bold text-white">
            {user?.name?.charAt(0).toUpperCase() || "U"}
          </span>
        ) : (
          <Sparkles className="w-4 h-4 text-indigo-400" />
        )}
      </div>

      {/* Message Content */}
      <div className={`flex flex-col max-w-[80%] ${isUser ? "items-end" : "items-start"}`}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-gray-300">
            {isUser ? user?.name || "You" : "Lumina"}
          </span>
          <span className="text-xs text-gray-500">
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        
        <div className={`px-5 py-3.5 rounded-2xl ${
          isUser 
            ? "bg-indigo-500 text-white rounded-tr-sm shadow-[0_0_15px_rgba(99,102,241,0.2)]" 
            : "bg-white/5 border border-white/10 text-gray-200 rounded-tl-sm"
        }`}>
          {/* Markdown rendering will go here in Phase 6 */}
          <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
        </div>
      </div>
    </motion.div>
  );
}

export function LoadingBubble() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex gap-4 w-full max-w-4xl mx-auto py-6"
    >
      <div className="shrink-0 w-8 h-8 rounded-full bg-white/10 border border-white/20 flex items-center justify-center">
        <Sparkles className="w-4 h-4 text-indigo-400 animate-pulse" />
      </div>
      <div className="flex flex-col items-start">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-gray-300">Lumina</span>
        </div>
        <div className="px-5 py-4 rounded-2xl rounded-tl-sm bg-white/5 border border-white/10 flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "0ms" }} />
          <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "150ms" }} />
          <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    </motion.div>
  );
}
