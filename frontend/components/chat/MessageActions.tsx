import { Check, Copy, RotateCcw, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AssistantMessageActionsProps {
  content: string;
  /** The whole-message copy button was just used (shows the check icon). */
  copied: boolean;
  isSpeaking: boolean;
  isPendingTTS: boolean;
  isStreaming?: boolean;
  onCopy: () => void;
  onToggleSpeech: () => void;
  onRegenerate?: () => void;
}

/** Copy / speak / regenerate controls under an assistant message. */
export function AssistantMessageActions({
  content,
  copied,
  isSpeaking,
  isPendingTTS,
  isStreaming,
  onCopy,
  onToggleSpeech,
  onRegenerate,
}: AssistantMessageActionsProps) {
  return (

    <div
      className={`mt-1.5 flex items-center gap-1 transition-opacity ${
        isSpeaking || isPendingTTS
          ? "opacity-100"
          : "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100"
      }`}
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg"
        onClick={onCopy}
        title="Copy message"
      >
        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
      </Button>

      {!isStreaming && content.trim() !== "" && (
        <Button
          variant="ghost"
          size="icon"
          className={`h-8 w-8 rounded-lg transition-all ${
            isSpeaking || isPendingTTS
              ? "text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20"
              : "text-gray-400 hover:text-white hover:bg-white/10"
          }`}
          onClick={onToggleSpeech}
          title={isSpeaking || isPendingTTS ? "Stop speaking" : "Speak response"}
        >
          {isSpeaking || isPendingTTS ? (
            <Square className="w-3.5 h-3.5 fill-current animate-pulse text-red-400" />
          ) : (
            <Volume2 className="w-4 h-4" />
          )}
        </Button>
      )}

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
  );
}

interface ErrorMessageActionsProps {
  copied: boolean;
  onCopy: () => void;
  onRetry?: () => void;
}

/** Retry / copy controls under an error message. */
export function ErrorMessageActions({ copied, onCopy, onRetry }: ErrorMessageActionsProps) {
  return (

    <div className="mt-1.5 flex items-center gap-1.5">
      {onRetry && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2.5 rounded-lg text-xs font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
          onClick={onRetry}
          title="Retry failed request"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Retry</span>
        </Button>
      )}

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg"
        onClick={onCopy}
        title="Copy error message"
      >
        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
      </Button>
    </div>
  );
}
