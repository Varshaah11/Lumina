import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { Check, Copy } from "lucide-react";
import { MermaidDiagram } from "./MermaidDiagram";

function getHeadingSlug(children: ReactNode, slugTracker: Map<string, number>): string {
  const extractText = (node: ReactNode): string => {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(extractText).join("");
    if (isValidElement<{ children?: ReactNode }>(node) && node.props.children) return extractText(node.props.children);
    return "";
  };

  const text = extractText(children);
  const baseSlug =
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "heading";

  const count = slugTracker.get(baseSlug) || 0;
  slugTracker.set(baseSlug, count + 1);

  return count === 0 ? baseSlug : `${baseSlug}-${count}`;
}

interface MarkdownContentProps {
  content: string;
  isStreaming?: boolean;
  /** Id of the most recently copied snippet (drives the "Copied" state of code-block copy buttons). */
  copiedId: string | null;
  onCopy: (text: string, id?: string) => void;
}

/** Renders assistant Markdown (GFM, math, syntax-highlighted code, Mermaid diagrams) with Lumina's styling. */
export function MarkdownContent({ content, isStreaming, copiedId, onCopy }: MarkdownContentProps) {
  // Heading ids are de-duplicated per render ("intro", "intro-1", ...)
  const slugTracker = new Map<string, number>();

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code({ node, className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const lang = match ? match[1].toLowerCase() : "";
          const codeText = String(children).replace(/\n$/, "");
          const id = Math.random().toString(36).substring(7);

          if (lang === "mermaid") {
            return <MermaidDiagram chart={codeText} isStreaming={isStreaming} />;
          }

          const isBlock = match || codeText.includes("\n");

          return isBlock ? (
            <div className="relative group/code my-4 rounded-xl overflow-hidden border border-white/10 bg-[#18181b] shadow-md">
              <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10 text-xs font-mono text-gray-400">
                <span className="font-semibold text-indigo-400 uppercase tracking-wider">
                  {match ? match[1] : "code"}
                </span>
                <button
                  type="button"
                  onClick={() => onCopy(codeText, id)}
                  className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors cursor-pointer"
                  title="Copy code"
                >
                  {copiedId === id ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400 font-sans font-medium">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span className="font-sans font-medium">Copy</span>
                    </>
                  )}
                </button>
              </div>
              <SyntaxHighlighter
                {...(props as Omit<typeof props, "ref">)}
                style={vscDarkPlus}
                language={match ? match[1] : "text"}
                PreTag="div"
                customStyle={{ margin: 0, padding: "1rem", background: "transparent", fontSize: "0.85rem" }}
              >
                {codeText}
              </SyntaxHighlighter>
            </div>
          ) : (
            <code
              {...props}
              className="bg-white/10 px-1.5 py-0.5 rounded-md text-indigo-300 font-mono text-xs border border-white/10"
            >
              {children}
            </code>
          );
        },
        h1({ children }) {
          const id = getHeadingSlug(children, slugTracker);
          return (
            <h1 id={id} className="text-2xl font-bold text-white mt-6 mb-3 pb-1.5 border-b border-white/10 scroll-mt-4">
              {children}
            </h1>
          );
        },
        h2({ children }) {
          const id = getHeadingSlug(children, slugTracker);
          return (
            <h2 id={id} className="text-xl font-bold text-white mt-5 mb-2.5 pb-1 border-b border-white/10 scroll-mt-4">
              {children}
            </h2>
          );
        },
        h3({ children }) {
          const id = getHeadingSlug(children, slugTracker);
          return (
            <h3 id={id} className="text-lg font-semibold text-white mt-4 mb-2 scroll-mt-4">
              {children}
            </h3>
          );
        },
        h4({ children }) {
          const id = getHeadingSlug(children, slugTracker);
          return (
            <h4 id={id} className="text-base font-semibold text-gray-200 mt-3 mb-1.5 scroll-mt-4">
              {children}
            </h4>
          );
        },
        h5({ children }) {
          const id = getHeadingSlug(children, slugTracker);
          return (
            <h5 id={id} className="text-sm font-semibold text-gray-300 mt-2 mb-1 scroll-mt-4">
              {children}
            </h5>
          );
        },
        h6({ children }) {
          const id = getHeadingSlug(children, slugTracker);
          return (
            <h6 id={id} className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-2 mb-1 scroll-mt-4">
              {children}
            </h6>
          );
        },
        p({ children }) {
          return <p className="my-2.5 leading-relaxed text-gray-200 text-sm">{children}</p>;
        },
        ul({ children }) {
          return <ul className="list-disc list-outside ml-5 space-y-1.5 my-3 text-gray-200 text-sm">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="list-decimal list-outside ml-5 space-y-1.5 my-3 text-gray-200 text-sm">{children}</ol>;
        },
        li({ children }) {
          return <li className="text-sm text-gray-200 leading-relaxed">{children}</li>;
        },
        blockquote({ children }) {
          return (
            <blockquote className="border-l-4 border-indigo-500 bg-indigo-500/10 px-4 py-3 my-4 rounded-r-xl text-gray-300 italic text-sm">
              {children}
            </blockquote>
          );
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-4 rounded-xl border border-white/10 bg-white/[0.02] shadow-sm">
              <table className="w-full text-left text-sm text-gray-300 border-collapse">{children}</table>
            </div>
          );
        },
        thead({ children }) {
          return <thead className="bg-white/5 border-b border-white/10 text-xs font-semibold text-gray-300 uppercase tracking-wider">{children}</thead>;
        },
        tbody({ children }) {
          return <tbody className="divide-y divide-white/5">{children}</tbody>;
        },
        tr({ children }) {
          return <tr className="hover:bg-white/[0.02] transition-colors">{children}</tr>;
        },
        th({ children }) {
          return <th className="px-4 py-3 text-left text-xs font-semibold text-gray-200 uppercase tracking-wider">{children}</th>;
        },
        td({ children }) {
          return <td className="px-4 py-3 text-sm text-gray-300 whitespace-normal">{children}</td>;
        },
        a({ href, children }) {
          const isExternal = href?.startsWith("http://") || href?.startsWith("https://");
          return (
            <a
              href={href}
              target={isExternal ? "_blank" : undefined}
              rel={isExternal ? "noopener noreferrer" : undefined}
              className="text-indigo-400 hover:text-indigo-300 underline underline-offset-4 decoration-indigo-500/50 hover:decoration-indigo-400 transition-colors font-medium"
            >
              {children}
            </a>
          );
        },
        hr() {
          return <hr className="my-6 border-t border-white/10" />;
        },
        del({ children }) {
          return <del className="line-through text-gray-400">{children}</del>;
        },
        input({ node, ...props }) {
          if (props.type === "checkbox") {
            return (
              <input
                {...props}
                disabled
                className="mr-2 rounded border-white/20 bg-white/10 text-indigo-500 focus:ring-0 focus:ring-offset-0 cursor-default accent-indigo-500"
              />
            );
          }
          return <input {...props} />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
