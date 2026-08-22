import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Paperclip, Square, Mic, X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

// Web Speech API TypeScript Declarations
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionResultAlternative;
  [index: number]: SpeechRecognitionResultAlternative;
}

interface SpeechRecognitionResultAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((this: SpeechRecognitionInstance, ev: Event) => void) | null;
  onresult: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognitionInstance, ev: Event) => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

interface ChatInputProps {
  onSend: (message: string, file?: File | null) => void;
  isLoading: boolean;
  onStop?: () => void;
}

const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export function ChatInput({ onSend, isLoading, onStop }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const initialInputRef = useRef<string>("");
  const noticeTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Check Web Speech API support on mount
  useEffect(() => {
    const supported =
      typeof window !== "undefined" &&
      !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    setIsSupported(supported);
  }, []);

  // Helper to show temporary non-blocking notices
  const showNotice = useCallback((msg: string) => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
    setNoticeMessage(msg);
    noticeTimerRef.current = setTimeout(() => {
      setNoticeMessage(null);
    }, 4000);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Clean up recognition on unmount
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore cleanup errors
        }
      }
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      showNotice("Only PDF, DOCX, TXT, and Markdown files are supported.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      showNotice(`File size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds 10 MB limit.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setSelectedFile(file);
    setNoticeMessage(null);
  };

  const handleRemoveFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore errors on stopping
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  const startListening = useCallback(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognitionClass =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      setIsSupported(false);
      showNotice("Voice input isn't supported in this browser.");
      return;
    }

    // Stop any existing instance
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
    }

    try {
      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      // Save initial text present before voice input started
      initialInputRef.current = input;

      recognition.onstart = () => {
        setIsListening(true);
        setNoticeMessage(null);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let currentFinal = "";
        let currentInterim = "";

        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            currentFinal += result[0].transcript;
          } else {
            currentInterim += result[0].transcript;
          }
        }

        const base = initialInputRef.current;
        let combined = base;

        if (currentFinal) {
          const needsSpace =
            base.length > 0 && !base.endsWith(" ") && !currentFinal.startsWith(" ");
          combined += (needsSpace ? " " : "") + currentFinal;
        }

        if (currentInterim) {
          const needsSpace =
            combined.length > 0 && !combined.endsWith(" ") && !currentInterim.startsWith(" ");
          combined += (needsSpace ? " " : "") + currentInterim;
        }

        setInput(combined);
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          showNotice("Microphone permission denied.");
        } else if (event.error !== "no-speech" && event.error !== "aborted") {
          showNotice("Voice recognition error.");
        }
        stopListening();
      };

      recognition.onend = () => {
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      showNotice("Failed to start voice input.");
      stopListening();
    }
  }, [input, showNotice, stopListening]);

  const toggleListening = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!input.trim() && !selectedFile) || isLoading) return;
    if (isListening) {
      stopListening();
    }
    onSend(input, selectedFile);
    setInput("");
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
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
      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        accept=".pdf,.docx,.txt,.md"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Selected File Preview Badge */}
      {selectedFile && (
        <div className="flex flex-col gap-2 p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-300 mb-2 shadow-sm animate-in fade-in slide-in-from-bottom-1">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-indigo-400 shrink-0" />
            <span className="font-medium truncate max-w-[250px]">{selectedFile.name}</span>
            <span className="text-gray-400 text-[10px]">
              ({(selectedFile.size / (1024 * 1024)).toFixed(2)} MB)
            </span>
            <button
              type="button"
              onClick={handleRemoveFile}
              className="ml-auto p-1 hover:bg-white/10 rounded-lg text-gray-400 hover:text-white transition-colors"
              title="Remove file"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-indigo-500/20">
            <span className="text-[11px] text-gray-400 font-medium mr-1">Quick Actions:</span>
            <button
              type="button"
              onClick={() => {
                onSend("Summarize this document in 5 key points.", selectedFile);
                handleRemoveFile();
              }}
              className="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/30 text-indigo-200 text-[11px] font-medium transition-all cursor-pointer"
            >
              ✨ Summarize
            </button>
            <button
              type="button"
              onClick={() => {
                onSend("Create exam-ready study notes from this document.", selectedFile);
                handleRemoveFile();
              }}
              className="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/30 text-indigo-200 text-[11px] font-medium transition-all cursor-pointer"
            >
              📝 Make Notes
            </button>
            <button
              type="button"
              onClick={() => {
                onSend("Explain the contents of this document like I am a beginner.", selectedFile);
                handleRemoveFile();
              }}
              className="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/30 text-indigo-200 text-[11px] font-medium transition-all cursor-pointer"
            >
              💡 Explain
            </button>
            <button
              type="button"
              onClick={() => {
                onSend("Quiz me on this document with 5 questions. Ask one question at a time.", selectedFile);
                handleRemoveFile();
              }}
              className="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/30 text-indigo-200 text-[11px] font-medium transition-all cursor-pointer"
            >
              🎯 Quiz Me
            </button>
          </div>
        </div>
      )}

      {/* Subtle indicator for Listening or Notices */}
      {isListening ? (
        <div className="absolute -top-7 left-4 flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs animate-pulse">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
          <span>Listening...</span>
        </div>
      ) : noticeMessage ? (
        <div className="absolute -top-7 left-4 flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
          <span>{noticeMessage}</span>
        </div>
      ) : null}

      <form 
        onSubmit={handleSubmit}
        className="relative flex items-end gap-2 bg-white/5 border border-white/10 rounded-2xl p-2 backdrop-blur-xl focus-within:ring-1 focus-within:ring-indigo-500/50 focus-within:border-indigo-500/50 transition-all shadow-xl"
      >
        <Button 
          type="button" 
          variant="ghost" 
          size="icon" 
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 h-10 w-10 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl mb-0.5"
          title="Attach document (PDF, DOCX, TXT, MD)"
        >
          <Paperclip className="w-5 h-5" />
        </Button>
        
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={selectedFile ? "Add a message about this file (optional)..." : "Ask Lumina anything..."}
          className="flex-1 max-h-[200px] min-h-[44px] bg-transparent border-0 resize-none py-3 px-2 text-white placeholder:text-gray-500 focus:ring-0 focus:outline-none"
          rows={1}
        />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleListening}
          className={`shrink-0 h-10 w-10 rounded-xl mb-0.5 transition-all ${
            isListening
              ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 shadow-lg shadow-red-500/10"
              : isSupported
              ? "text-gray-400 hover:text-white hover:bg-white/5"
              : "text-gray-600 cursor-not-allowed opacity-50"
          }`}
          title={
            isListening
              ? "Stop listening"
              : isSupported
              ? "Start voice input"
              : "Voice input isn't supported in this browser"
          }
        >
          <Mic className={`w-5 h-5 ${isListening ? "animate-pulse text-red-400" : ""}`} />
        </Button>
        
        {isLoading ? (
          <Button
            type="button"
            onClick={onStop}
            className="shrink-0 h-10 w-10 rounded-xl mb-0.5 flex items-center justify-center transition-all bg-red-500/20 text-red-400 hover:bg-red-500/30 shadow-lg"
            title="Stop generation"
          >
            <Square className="w-4 h-4 fill-current" />
          </Button>
        ) : (
          <Button 
            type="submit" 
            disabled={!input.trim() && !selectedFile}
            className={`shrink-0 h-10 w-10 rounded-xl mb-0.5 flex items-center justify-center transition-all ${
              input.trim() || selectedFile
                ? "bg-gradient-to-br from-indigo-500 to-purple-500 text-white shadow-lg" 
                : "bg-white/5 text-gray-500"
            }`}
          >
            <Send className="w-4 h-4" />
          </Button>
        )}
      </form>
      <div className="text-center mt-3">
        <p className="text-xs text-gray-500">
          Lumina can make mistakes. Consider verifying important information.
        </p>
      </div>
    </div>
  );
}

