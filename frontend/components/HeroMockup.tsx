"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FileText, Mic, Sparkles, User } from "lucide-react";

export function HeroMockup() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer1 = setTimeout(() => setStep(1), 1500); // User message
    const timer2 = setTimeout(() => setStep(2), 3000); // AI thinking/typing
    const timer3 = setTimeout(() => setStep(3), 5000); // AI response streaming
    
    // Loop
    const reset = setInterval(() => {
      setStep(0);
      setTimeout(() => setStep(1), 1500);
      setTimeout(() => setStep(2), 3000);
      setTimeout(() => setStep(3), 5000);
    }, 12000);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
      clearInterval(reset);
    };
  }, []);

  const codeSnippet = `def hello():
    print("Hello, Lumina!")`;

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl border border-white/10 bg-black/40 backdrop-blur-xl shadow-[0_0_50px_rgba(99,102,241,0.15)] overflow-hidden flex flex-col relative">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between bg-white/5">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-medium text-white">Lumina</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-500/10 text-green-400 text-xs font-medium border border-green-500/20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            Voice Mode Enabled
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 p-6 flex flex-col gap-6 min-h-[360px] max-h-[360px] overflow-hidden relative">
        <AnimatePresence>
          {step >= 1 && (
            <motion.div
              key="user-msg"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-4 justify-end"
            >
              <div className="flex flex-col items-end gap-2 max-w-[80%]">
                <div className="bg-white/10 text-white px-4 py-2 rounded-2xl rounded-tr-sm text-sm border border-white/5">
                  Summarize this PDF and write a python script.
                </div>
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg p-2 pr-4">
                  <div className="w-8 h-8 rounded-md bg-red-500/20 flex items-center justify-center text-red-400">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-xs font-medium text-white">AI_Research.pdf</span>
                    <span className="text-[10px] text-gray-500">1.2 MB</span>
                  </div>
                </div>
              </div>
              <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-1 border border-indigo-500/30">
                <User className="w-4 h-4 text-indigo-300" />
              </div>
            </motion.div>
          )}

          {step >= 2 && (
            <motion.div
              key="ai-msg"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-4"
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center flex-shrink-0 mt-1 shadow-[0_0_10px_rgba(99,102,241,0.5)]">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              
              <div className="flex flex-col gap-3 max-w-[85%]">
                {step === 2 && (
                  <div className="flex items-center gap-1.5 h-6 px-4 bg-white/5 rounded-full border border-white/10 w-fit">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                )}
                
                {step >= 3 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex flex-col gap-3"
                  >
                    <div className="text-sm text-gray-300 leading-relaxed">
                      I've analyzed your document. Here are the key insights from the research paper, along with the requested script:
                    </div>
                    
                    <div className="rounded-lg bg-black/60 border border-white/10 overflow-hidden font-mono text-xs">
                      <div className="flex items-center justify-between px-3 py-2 bg-white/5 border-b border-white/10">
                        <span className="text-gray-400">python</span>
                      </div>
                      <div className="p-4 text-gray-300">
                        <span className="text-purple-400">def</span> <span className="text-blue-400">hello</span>():<br/>
                        &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-purple-400">print</span>(<span className="text-green-400">"Hello, Lumina!"</span>)
                        <span className="inline-block w-1.5 h-3.5 ml-1 bg-white animate-pulse translate-y-0.5" />
                      </div>
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Input Area */}
      <div className="p-4 bg-black/60 border-t border-white/10">
        <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-full px-4 py-2.5">
          <FileText className="w-5 h-5 text-gray-400" />
          <div className="flex-1 text-sm text-gray-500">Ask Lumina anything...</div>
          <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-400 cursor-pointer hover:bg-indigo-500/30 transition-colors">
            <Mic className="w-4 h-4" />
          </div>
        </div>
      </div>
    </div>
  );
}
