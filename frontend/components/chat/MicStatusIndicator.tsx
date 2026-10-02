interface MicStatusIndicatorProps {
  /** User has switched the always-on wake-word microphone on. */
  enabled: boolean;
  /** The browser's speech recognition is actually running (the microphone is capturing). */
  active: boolean;
  onToggle: () => void;
}

/**
 * Always-visible microphone state for the hands-free wake word. The microphone is OFF by default and only
 * turns on after the user presses the button; while it is capturing, the indicator is red and says so.
 */
export function MicStatusIndicator({ enabled, active, onToggle }: MicStatusIndicatorProps) {
  const label = active
    ? enabled
      ? "Microphone ON — listening for “Lumina”"
      : "Microphone ON"
    : enabled
    ? "Waiting for microphone access…"
    : "Microphone off";
  const dot = active ? "bg-red-500 animate-pulse" : enabled ? "bg-amber-400" : "bg-gray-500";
  const border = active ? "border-red-500/40" : "border-white/10";

  return (
    <div
      role="status"
      aria-live="polite"
      data-mic-active={active ? "true" : "false"}
      className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/5 border ${border} text-xs text-gray-300 backdrop-blur-md`}
    >
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span>{label}</span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={enabled}
        aria-label={enabled ? "Turn off hands-free wake word and microphone" : "Turn on hands-free wake word and microphone"}
        className="ml-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded px-1"
      >
        {enabled ? "Turn off" : "Turn on"}
      </button>
    </div>
  );
}
