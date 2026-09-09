import { motion } from "framer-motion";
import { VoiceState } from "@/hooks/useVoiceConversation";
import { Mic, Sparkles, Volume2, Loader2, AlertCircle, Check } from "lucide-react";

interface VoiceOrbProps {
  state: VoiceState;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export function VoiceOrb({ state, onClick, disabled = false, className = "" }: VoiceOrbProps) {
  // State specific gradient and shadow configs
  const getOrbStyle = () => {
    switch (state) {
      case "LISTENING":
        return {
          gradient: "from-rose-500 via-red-500 to-amber-500",
          shadow: "shadow-[0_0_60px_rgba(244,63,94,0.5)]",
          ringColor: "border-rose-500/40",
          icon: Mic,
          label: "Listening",
        };
      case "THINKING":
        return {
          gradient: "from-indigo-500 via-purple-500 to-cyan-400",
          shadow: "shadow-[0_0_60px_rgba(99,102,241,0.6)]",
          ringColor: "border-indigo-500/40",
          icon: Loader2,
          label: "Thinking",
        };
      case "SPEAKING":
        return {
          gradient: "from-cyan-400 via-emerald-400 to-indigo-500",
          shadow: "shadow-[0_0_60px_rgba(6,182,212,0.6)]",
          ringColor: "border-cyan-400/40",
          icon: Volume2,
          label: "Speaking",
        };
      case "ACTION":
        return {
          gradient: "from-emerald-500 via-teal-500 to-indigo-500",
          shadow: "shadow-[0_0_60px_rgba(16,185,129,0.6)]",
          ringColor: "border-emerald-400/40",
          icon: Check,
          label: "Action",
        };
      case "ERROR":
        return {
          gradient: "from-amber-500 to-red-600",
          shadow: "shadow-[0_0_50px_rgba(245,158,11,0.4)]",
          ringColor: "border-amber-500/40",
          icon: AlertCircle,
          label: "Error",
        };
      case "IDLE":
      default:
        return {
          gradient: "from-indigo-600 via-purple-600 to-pink-500",
          shadow: "shadow-[0_0_40px_rgba(99,102,241,0.3)]",
          ringColor: "border-white/10",
          icon: Sparkles,
          label: "Tap to Speak",
        };
    }
  };

  const style = getOrbStyle();
  const IconComponent = style.icon;

  return (
    <div className={`relative flex items-center justify-center w-64 h-64 select-none ${className}`}>
      {/* Outer Pulse Wave Rings for LISTENING and SPEAKING */}
      {state === "LISTENING" && (
        <motion.div
          animate={{ scale: [1, 1.4, 1], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 rounded-full border border-rose-500/40 pointer-events-none"
        />
      )}

      {state === "SPEAKING" && (
        <motion.div
          animate={{ scale: [1, 1.3, 0.95, 1.2, 1], opacity: [0.5, 0.1, 0.5] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 rounded-full border border-cyan-400/50 pointer-events-none"
        />
      )}

      {/* Rotating Ring for THINKING */}
      {state === "THINKING" && (
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
          className="absolute -inset-4 rounded-full border-2 border-dashed border-cyan-400/60 pointer-events-none"
        />
      )}

      {/* Main Orb Sphere */}
      <motion.button
        type="button"
        disabled={disabled}
        aria-label={`Voice Orb: ${style.label}`}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!disabled) onClick?.();
          }
        }}
        animate={
          state === "LISTENING"
            ? { scale: [1, 1.08, 1] }
            : state === "THINKING"
            ? { scale: [1, 1.04, 0.98, 1.04, 1], rotate: [0, 90, 180, 270, 360] }
            : state === "SPEAKING"
            ? { scale: [1, 1.07, 0.97, 1.05, 1] }
            : { scale: [1, 1.03, 1] }
        }
        transition={
          state === "THINKING"
            ? { duration: 6, repeat: Infinity, ease: "linear" }
            : { duration: 2.2, repeat: Infinity, ease: "easeInOut" }
        }
        className={`w-48 h-48 rounded-full bg-gradient-to-tr ${style.gradient} ${style.shadow} p-1 backdrop-blur-3xl flex items-center justify-center cursor-pointer transition-all duration-500 group relative overflow-hidden active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-400/80 focus-visible:ring-offset-4 focus-visible:ring-offset-black disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed`}
      >
        {/* Shimmer overlay */}
        <div className="absolute inset-0 bg-white/10 rounded-full blur-md opacity-40 group-hover:opacity-70 transition-opacity" />

        {/* Inner Glass Core */}
        <div className="w-full h-full rounded-full bg-black/30 backdrop-blur-md flex flex-col items-center justify-center p-4 border border-white/20 relative z-10">
          <IconComponent
            className={`w-10 h-10 mb-2 text-white transition-all ${
              state === "THINKING" ? "animate-spin" : state === "LISTENING" ? "animate-pulse" : ""
            }`}
          />
          <span className="text-xs font-semibold tracking-wider text-white uppercase text-center drop-shadow">
            {style.label}
          </span>
        </div>
      </motion.button>
    </div>
  );
}
