/**
 * Converts rich markdown and math/LaTeX text into clean, natural conversational speech for Kokoro TTS.
 * Ensures Kokoro never pronounces formatting symbols like "asterisk", "backtick", "hash", "backslash", or math delimiters.
 */
export function sanitizeTextForTTS(rawText: string): string {
  if (!rawText) return "";

  let text = rawText;

  // 1. Silently remove Mermaid diagram blocks: ```mermaid ... ```
  text = text.replace(/```\s*mermaid[\s\S]*?```/gi, "");

  // 2. Remove or summarize complete fenced code blocks ```lang ... ```
  text = text.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (match, code) => {
    if (
      code.includes("def ") ||
      code.includes("function ") ||
      code.includes("const ") ||
      code.includes("class ") ||
      code.includes("return ")
    ) {
      return ". Here is a code example. ";
    }
    return ". ";
  });

  // 2. Handle actively streaming unclosed code block (e.g. ```python ... without closing ```)
  const unclosedIdx = text.lastIndexOf("```");
  if (unclosedIdx !== -1) {
    text = text.slice(0, unclosedIdx);
  }

  // 3. LaTeX / Math Expressions:
  // Strip delimiters first: $$...$$, \[...\], \(...\)
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, " $1 ");
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, " $1 ");
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, " $1 ");
  text = text.replace(/\$([^$\n]+)\$/g, " $1 ");

  // Convert basic math symbols and expressions to spoken words
  text = text.replace(/\\times\b/g, " times ");
  text = text.replace(/\\cdot\b/g, " times ");
  text = text.replace(/\\div\b/g, " divided by ");
  text = text.replace(/\\(?:pm|plusminus)\b/g, " plus or minus ");
  text = text.replace(/\\(?:le|leq)\b/g, " less than or equal to ");
  text = text.replace(/\\(?:ge|geq)\b/g, " greater than or equal to ");
  text = text.replace(/\\(?:ne|neq)\b/g, " not equal to ");
  text = text.replace(/\\approx\b/g, " approximately ");
  text = text.replace(/\\infty\b/g, " infinity ");
  text = text.replace(/\\sqrt\{([^}]+)\}/g, " square root of $1 ");
  text = text.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, " $1 over $2 ");
  text = text.replace(/\\left\(/g, " (");
  text = text.replace(/\\right\)/g, ") ");
  text = text.replace(/([a-zA-Z0-9]+)!/g, "$1 factorial");

  // Strip LaTeX commands like \text{...}, \mathbf{...}, \mathit{...}
  text = text.replace(/\\(?:text|mathbf|mathit|mathrm|mathcal)\{([^}]+)\}/g, " $1 ");
  // Strip any remaining backslashes and LaTeX control words
  text = text.replace(/\\[a-zA-Z]+/g, " ");
  text = text.replace(/\\/g, " ");

  // 4. Horizontal rules (---, ===, ***, ___, -----)
  text = text.replace(/^[ \t]*[-*=_]{2,}[ \t]*$/gm, " ");

  // 5. Markdown table rows: | col | col |
  text = text.replace(/^[ \t]*\|.*\|[ \t]*$/gm, " ");

  // 6. ATX headings: # Header -> Header.
  text = text.replace(/^[ \t]*#{1,6}\s+(.+)$/gm, "$1. ");

  // 7. Blockquotes: > Quote -> Quote
  text = text.replace(/^[ \t]*>\s+/gm, " ");

  // 8. List items:
  // - bullet item -> bullet item.
  // 1. item -> item.
  text = text.replace(/^[ \t]*[•–—▪▫◆◇➢▶\-\*\+]\s+(.+)$/gm, "$1. ");
  text = text.replace(/^[ \t]*\d+\.\s+(.+)$/gm, "$1. ");
  text = text.replace(/[•–—▪▫◆◇➢▶]/g, " ");

  // 9. Inline code: `code` -> code
  text = text.replace(/`([^`]+)`/g, "$1");

  // 10. Links and images: [text](url) -> text, ![alt](url) -> ""
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // 11. Bold, italic, strikethrough: **bold**, *italic*, ~~strike~~
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$2");

  // 12. Strip standalone symbols and repeated formatting characters
  text = text.replace(/[-*=_]{2,}/g, " ");
  text = text.replace(/#{2,}/g, " ");
  text = text.replace(/[*_~`^<>{}[\]|]/g, " ");

  // 13. HTML tags
  text = text.replace(/<[^>]*>/g, " ");

  // 14. URLs
  text = text.replace(/https?:\/\/\S+/g, "");

  // 15. Clean spacing and normalize punctuation pauses
  text = text.replace(/\.{2,}/g, ".");
  text = text.replace(/\n+/g, ". ");
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\s+([.,!?;:])/g, "$1");
  text = text.replace(/([.,!?;:])\s*\1+/g, "$1");

  return text.trim();
}

/**
 * Checks if the transcript contains a wake word trigger ("Lumina" or "Hey Lumina")
 * and extracts any trailing user question.
 */
export function parseWakeWord(transcript: string): { isWake: boolean; prompt: string } {
  if (!transcript) return { isWake: false, prompt: "" };
  const clean = transcript.trim();
  // Must begin with optional greeting ("hey", "hi", "hello", "ok") followed by "lumina"
  const match = /^(?:(?:hey|hi|hello|ok)\s+)?lumina\b[,\s]*(.*)$/i.exec(clean);
  if (!match) return { isWake: false, prompt: "" };

  const prompt = (match[1] || "").trim().replace(/^[,\.\?!;:\s]+/, "");
  return { isWake: true, prompt };
}

/**
 * Determines whether the user transcript is an interruption command while Lumina is speaking.
 * Supports: "stop", "Lumina stop", "stop Lumina", "be quiet", "cancel", "pause".
 * Protects against false interruption from Lumina's own voice echo.
 */
export function isInterruptionCommand(transcript: string, currentSpokenAssistantText?: string): boolean {
  if (!transcript) return false;
  const clean = transcript.trim().toLowerCase();

  // 1. Explicit multi-word interruption phrases: always trigger
  const explicitRegex = /\b(lumina\s+stop|stop\s+lumina|be\s+quiet|shut\s+up|please\s+stop|stop\s+talking|cancel|pause)\b/i;
  if (explicitRegex.test(clean)) {
    return true;
  }

  // 2. Standalone or short "stop" command
  if (/\bstop\b/i.test(clean)) {
    if (currentSpokenAssistantText) {
      const assistantLower = currentSpokenAssistantText.toLowerCase();
      // If assistant text does NOT contain the word "stop", this is 100% user interruption
      if (!assistantLower.includes("stop")) {
        return true;
      }
      // If assistant text contains "stop", verify transcript is a short command (<= 3 words)
      const words = clean.split(/\s+/).filter(Boolean);
      if (words.length <= 3) {
        return true;
      }
      // If transcript is long and matches assistant text, it's likely an echo
      return false;
    }
    return true;
  }

  return false;
}
