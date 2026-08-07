import { useState } from "react";
import { Message } from "@/hooks/useChat";
import { Sparkles, User as UserIcon, Copy, Check, RotateCcw, AlertCircle } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/useAuth";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { Button } from "@/components/ui/button";

export function ChatBubble({ message, onRegenerate }: { message: Message, onRegenerate?: () => void }) {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  const { user } = useAuth();
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center shadow-md ${
        isUser 
          ? "bg-gradient-to-br from-indigo-500 to-purple-500" 
          : isError
            ? "bg-red-500/20 border border-red-500/50 text-red-400"
            : "bg-white/10 border border-white/20"
      }`}>
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
      <div className={`flex flex-col max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
        <div className="flex items-center gap-2 mb-1 px-1">
          <span className="text-sm font-medium text-gray-300">
            {isUser ? user?.name || "You" : isError ? "System Error" : "Lumina"}
          </span>
          <span className="text-xs text-gray-500">
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        
        <div className={`px-5 py-4 rounded-2xl relative group ${
          isUser 
            ? "bg-indigo-500 text-white rounded-tr-sm shadow-[0_0_15px_rgba(99,102,241,0.2)]" 
            : isError
              ? "bg-red-500/10 border border-red-500/20 text-red-200 rounded-tl-sm"
              : "bg-white/5 border border-white/10 text-gray-200 rounded-tl-sm shadow-sm"
        }`}>
          {isUser ? (
            <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
          ) : !isError && message.content === "" ? (
            <div className="flex items-center gap-1.5 h-6">
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-2 h-2 rounded-full bg-indigo-400/50 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          ) : (
            <div className="prose prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 prose-pre:bg-transparent">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ node, inline, className, children, ...props }: any) {
                    const match = /language-(\w+)/.exec(className || "");
                    const id = Math.random().toString(36).substring(7);
                    
                    return !inline && match ? (
                      <div className="relative group/code mt-4 mb-4 rounded-lg overflow-hidden border border-white/10 bg-[#1e1e1e]">
                        <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
                          <span className="text-xs font-mono text-gray-400">{match[1]}</span>
                          <button
                            onClick={() => copyToClipboard(String(children).replace(/\n$/, ""), id)}
                            className="text-gray-400 hover:text-white transition-colors"
                            title="Copy code"
                          >
                            {copiedId === id ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                          </button>
                        </div>
                        <SyntaxHighlighter
                          {...props}
                          style={vscDarkPlus}
                          language={match[1]}
                          PreTag="div"
                          customStyle={{ margin: 0, padding: '1rem', background: 'transparent' }}
                        >
                          {String(children).replace(/\n$/, "")}
                        </SyntaxHighlighter>
                      </div>
                    ) : (
                      <code {...props} className={`${className} bg-white/10 px-1.5 py-0.5 rounded-md text-indigo-300 font-mono text-sm`}>
                        {children}
                      </code>
                    );
                  }
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}

          {/* Assistant Message Actions */}
          {!isUser && !isError && (
            <div className="absolute -bottom-10 left-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg"
                onClick={() => copyToClipboard(message.content)}
                title="Copy message"
              >
                {copiedId === "msg" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </Button>
              {onRegenerate && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg"
                  onClick={onRegenerate}
                  title="Regenerate response"
                >
                  <RotateCcw className="w-4 h-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
