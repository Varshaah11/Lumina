import { Sparkles } from "lucide-react";
import { motion } from "framer-motion";

export function TypingIndicator() {
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
        <div className="px-5 py-4 rounded-2xl rounded-tl-sm bg-white/5 border border-white/10 flex items-center gap-1.5 shadow-sm">
          <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "0ms" }} />
          <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "150ms" }} />
          <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    </motion.div>
  );
}
