"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { HeroMockup } from "./HeroMockup";

const PROMPTS = [
  "Summarize this PDF",
  "Explain React Hooks",
  "Generate SQL Query",
  "Review my resume",
  "Debug this Python code"
];

export function Hero() {
  const [promptIndex, setPromptIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setPromptIndex((current) => (current + 1) % PROMPTS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-32 pb-20">
      {/* Dynamic Background */}
      <div className="absolute inset-0 w-full h-full -z-10">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-indigo-500/20 blur-[120px] rounded-full mix-blend-screen animate-pulse" />
        <div className="absolute top-1/3 right-1/4 w-[400px] h-[400px] bg-purple-500/20 blur-[120px] rounded-full mix-blend-screen animate-pulse" style={{ animationDelay: '2s' }} />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />
      </div>

      <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-12 items-center">
        
        {/* Left Column - Text */}
        <div className="flex flex-col items-center lg:items-start text-center lg:text-left z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-sm text-gray-300 mb-8"
          >
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <span>Introducing Lumina AI 1.0</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="text-5xl md:text-7xl lg:text-6xl xl:text-7xl font-bold tracking-tight text-white mb-6 leading-tight"
          >
            Your Intelligent <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-indigo-400 animate-gradient-x">
              Virtual Assistant
            </span>
          </motion.h1>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="text-lg md:text-xl text-gray-400 mb-10 max-w-xl font-light h-16 flex items-start justify-center lg:justify-start"
          >
            <span>Ask Lumina to</span>
            <span className="relative ml-2 w-48 text-left inline-block text-white font-medium">
              <AnimatePresence mode="wait">
                <motion.span
                  key={promptIndex}
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -20, opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="absolute left-0 top-0 whitespace-nowrap"
                >
                  "{PROMPTS[promptIndex]}"
                </motion.span>
              </AnimatePresence>
            </span>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="flex flex-col sm:flex-row gap-4 w-full justify-center lg:justify-start"
          >
            <Link href="/register">
              <Button size="lg" className="w-full sm:w-auto bg-white text-black hover:bg-gray-200 rounded-full text-base px-8 h-12">
                Try Lumina for Free
                <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </Link>
            <Link href="#features">
              <Button size="lg" variant="outline" className="w-full sm:w-auto rounded-full text-base px-8 h-12 bg-white/5 border-white/10 text-white hover:bg-white/10 hover:text-white">
                Explore Features
              </Button>
            </Link>
          </motion.div>
        </div>

        {/* Right Column - Mockup */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="w-full"
        >
          <HeroMockup />
        </motion.div>

      </div>
    </section>
  );
}
