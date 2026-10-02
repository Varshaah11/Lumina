/** Pure text helpers that turn a streaming assistant reply into small natural speech chunks. */

/**
 * Verifies that a text chunk contains meaningful natural language words.
 */
export function isMeaningfulSpeechChunk(chunk: string): boolean {
  if (!chunk || chunk.trim().length < 3) return false;
  const hasWord = /[a-zA-Z]{2,}/.test(chunk);
  if (!hasWord) return false;

  const strippedOfSymbols = chunk.replace(/[^a-zA-Z0-9]/g, "");
  if (strippedOfSymbols.length < 2) return false;

  return true;
}

/**
 * Hybrid streaming speech chunker.
 * Targets small natural speech units (~40-80 chars, or complete short clauses/sentences)
 * to ensure first audio latency is fast while preserving natural phrasing.
 */
export function extractStreamingTTSChunks(
  sanitizedText: string,
  processedLen: number,
  isComplete: boolean
): { text: string; rawLength: number }[] {
  const chunks: { text: string; rawLength: number }[] = [];
  let remaining = sanitizedText.slice(processedLen);
  let advancedLen = 0;

  while (remaining.length > 0) {
    if (remaining.length < 35 && !isComplete) {
      break;
    }

    // 1. Look for sentence or clause boundaries (. ? ! ; : ,) between 35 and 90 chars
    const punctRegex = /([.?!;]+|:\s+|,|\n+)/g;
    let match: RegExpExecArray | null;
    let foundSplitIdx = -1;

    while ((match = punctRegex.exec(remaining)) !== null) {
      const idxAfter = match.index + match[0].length;
      if (idxAfter >= 35 && idxAfter <= 90) {
        foundSplitIdx = idxAfter;
        break;
      }
      if (idxAfter > 90) {
        break;
      }
    }

    if (foundSplitIdx !== -1) {
      const candidate = remaining.slice(0, foundSplitIdx).trim();
      advancedLen += foundSplitIdx;
      remaining = remaining.slice(foundSplitIdx);
      if (isMeaningfulSpeechChunk(candidate)) {
        chunks.push({ text: candidate, rawLength: advancedLen });
        advancedLen = 0;
      }
      continue;
    }

    // 2. Length-based boundary: if text reaches >= 65 chars without punctuation split,
    // split at the nearest whitespace between 35 and 80 chars
    if (remaining.length >= 65) {
      const searchLimit = Math.min(80, remaining.length);
      const lastSpaceIdx = remaining.lastIndexOf(" ", searchLimit);
      if (lastSpaceIdx >= 35) {
        const candidate = remaining.slice(0, lastSpaceIdx).trim();
        advancedLen += lastSpaceIdx + 1;
        remaining = remaining.slice(lastSpaceIdx + 1);
        if (isMeaningfulSpeechChunk(candidate)) {
          chunks.push({ text: candidate, rawLength: advancedLen });
          advancedLen = 0;
        }
        continue;
      }
    }

    // 3. Final remaining chunk when LLM stream is complete
    if (isComplete) {
      const candidate = remaining.trim();
      advancedLen += remaining.length;
      remaining = "";
      if (isMeaningfulSpeechChunk(candidate)) {
        chunks.push({ text: candidate, rawLength: advancedLen });
      }
      break;
    }

    break;
  }

  return chunks;
}
