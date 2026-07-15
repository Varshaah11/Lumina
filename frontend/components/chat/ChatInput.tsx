import { useState, useRef, useEffect } from "react";
import { Send, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading: boolean;
}

export function ChatInput({ onSend, isLoading }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;
    onSend(input);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 pb-6 pt-2 relative">
      <form 
        onSubmit={handleSubmit}
        className="relative flex items-end gap-2 bg-white/5 border border-white/10 rounded-2xl p-2 backdrop-blur-xl focus-within:ring-1 focus-within:ring-indigo-500/50 focus-within:border-indigo-500/50 transition-all shadow-xl"
      >
        <Button 
          type="button" 
          variant="ghost" 
          size="icon" 
          className="shrink-0 h-10 w-10 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl mb-0.5"
          title="Attach file (UI only for now)"
        >
          <Paperclip className="w-5 h-5" />
        </Button>
        
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Lumina anything..."
          className="flex-1 max-h-[200px] min-h-[44px] bg-transparent border-0 resize-none py-3 px-2 text-white placeholder:text-gray-500 focus:ring-0 focus:outline-none"
          rows={1}
          disabled={isLoading}
        />
        
        <Button 
          type="submit" 
          disabled={!input.trim() || isLoading}
          className={`shrink-0 h-10 w-10 rounded-xl mb-0.5 flex items-center justify-center transition-all ${
            input.trim() && !isLoading 
              ? "bg-gradient-to-br from-indigo-500 to-purple-500 text-white shadow-lg" 
              : "bg-white/5 text-gray-500"
          }`}
        >
          <Send className="w-4 h-4" />
        </Button>
      </form>
      <div className="text-center mt-3">
        <p className="text-xs text-gray-500">
          Lumina can make mistakes. Consider verifying important information.
        </p>
      </div>
    </div>
  );
}
