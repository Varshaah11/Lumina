/** The user's own message: plain text, with a document chip for attached files (current and legacy formats). */
export function UserMessageContent({ content }: { content: string }) {
  if (!content) return null;

  // Handle legacy format containing embedded raw extracted text
  if (content.includes("Extracted Content:") && content.includes('"""')) {
    const filenameMatch = content.match(/\[Attached Document:\s*([^\]]+)\]/i);
    const filename = filenameMatch ? filenameMatch[1].trim() : "Attached Document";

    const lastQuoteIndex = content.lastIndexOf('"""');
    const prompt = lastQuoteIndex !== -1 ? content.slice(lastQuoteIndex + 3).trim() : "";

    return (
      <div className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 border border-white/20 text-xs font-medium text-white w-fit shadow-sm">
          <span>📄</span>
          <span>{filename}</span>
        </div>
        {prompt && <div className="whitespace-pre-wrap leading-relaxed text-sm">{prompt}</div>}
      </div>
    );
  }

  // Handle file header format: 📄 filename.pdf\n\nUser prompt
  if (content.startsWith("📄 ")) {
    const parts = content.split("\n\n");
    const filename = parts[0].slice(2).trim();
    const prompt = parts.slice(1).join("\n\n").trim();

    return (
      <div className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 border border-white/20 text-xs font-medium text-white w-fit shadow-sm">
          <span>📄</span>
          <span>{filename}</span>
        </div>
        {prompt && <div className="whitespace-pre-wrap leading-relaxed text-sm">{prompt}</div>}
      </div>
    );
  }

  return <div className="whitespace-pre-wrap leading-relaxed text-sm">{content}</div>;
}
