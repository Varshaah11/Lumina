import { Sparkles, MessageSquare, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";

interface EmptyStateProps {
  onActionClick: (text: string) => void;
}

export function EmptyState({ onActionClick }: EmptyStateProps) {
  const suggestions = [
    "Summarize a complex topic",
    "Help me write an email",
    "Explain quantum computing",
    "Brainstorm marketing ideas",
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full max-w-3xl mx-auto px-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center mb-8 border border-white/10 shadow-[0_0_50px_rgba(99,102,241,0.15)]"
      >
        <Sparkles className="w-10 h-10 text-indigo-400" />
      </motion.div>
      
      <motion.h2 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="text-3xl font-bold text-white mb-3"
      >
        How can I help you today?
      </motion.h2>
      
      <motion.p 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="text-gray-400 text-center max-w-lg mb-10"
      >
        I'm Lumina, your advanced AI assistant. Start a conversation or pick a suggestion below.
      </motion.p>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
        {suggestions.map((text, i) => (
          <motion.button
            key={text}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 + (i * 0.1) }}
            onClick={() => onActionClick(text)}
            className="group p-4 rounded-xl bg-white/5 border border-white/10 hover:border-indigo-500/50 hover:bg-white/10 transition-all text-left flex items-start justify-between"
          >
            <div className="flex items-center gap-3">
              <MessageSquare className="w-5 h-5 text-indigo-400 shrink-0" />
              <span className="text-gray-300 group-hover:text-white transition-colors">{text}</span>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-500 group-hover:text-indigo-400 group-hover:translate-x-1 transition-all" />
          </motion.button>
        ))}
      </div>
    </div>
  );
}
