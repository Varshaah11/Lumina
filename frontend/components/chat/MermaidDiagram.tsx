"use client";

import { useEffect, useState, useRef } from "react";
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { Check, Copy, Code, Loader2 } from "lucide-react";

// Patch DOMPurify factory at client module-load time so Mermaid v11 has access to addHook and sanitize methods
if (typeof window !== "undefined") {
  try {
    const purifyInstance = typeof (DOMPurify as any) === "function" ? (DOMPurify as any)(window) : DOMPurify;
    if (purifyInstance) {
      (window as any).DOMPurify = purifyInstance;
      Object.assign(DOMPurify, purifyInstance);
    }
  } catch (e) {
    console.warn("[MermaidDiagram] DOMPurify setup warning:", e);
  }
}

let isMermaidInitialized = false;

function ensureMermaidInitialized() {
  if (typeof window === "undefined" || isMermaidInitialized) return;

  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "strict",
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  });

  isMermaidInitialized = true;
}

function fixNodeId(nodeStr: string): string {
  const trimmed = nodeStr.trim();
  if (
    trimmed.includes("-->") ||
    trimmed.includes("---") ||
    trimmed.includes("->") ||
    trimmed.includes("<--") ||
    trimmed.includes("==>")
  ) {
    return trimmed;
  }
  const bracketIndex = trimmed.indexOf("[");
  if (bracketIndex > 0) {
    const idPart = trimmed.substring(0, bracketIndex).trim();
    const labelPart = trimmed.substring(bracketIndex);
    if (idPart.includes(" ")) {
      return `${idPart.replace(/\s+/g, "_")}${labelPart}`;
    }
    return trimmed;
  } else if (trimmed.includes(" ") && !trimmed.includes("[")) {
    const safeId = trimmed.replace(/\s+/g, "_");
    return `${safeId}["${trimmed}"]`;
  }
  return trimmed;
}

function normalizeMermaidSource(chart: string): string {
  let cleaned = chart.trim();

  if (cleaned.startsWith("```mermaid")) {
    cleaned = cleaned.substring(10).replace(/```$/, "").trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3).replace(/```$/, "").trim();
  }

  // Do not modify sequence diagrams or non-flowcharts
  if (cleaned.toLowerCase().includes("sequencediagram")) {
    return cleaned;
  }

  // 1. Safely fix malformed edge-label trailing '>' (e.g. -->|Label|> => -->|Label|)
  cleaned = cleaned.replace(/((?:-->|---|-->|<--|--|-\.->|==>))\s*\|([^|\n]+)\|\s*>\s*/g, "$1|$2| ");

  // 2. Line-by-line processing for edge definitions and node IDs containing unbracketed spaces
  const lines = cleaned.split("\n").map((line) => {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("graph") ||
      trimmed.startsWith("flowchart") ||
      trimmed.startsWith("%%") ||
      trimmed.startsWith("style ") ||
      trimmed.startsWith("classDef ") ||
      trimmed.startsWith("class ") ||
      trimmed.startsWith("click ")
    ) {
      return line;
    }

    // Match flowchart edge arrows (do NOT match sequence arrows like ->>)
    const edgeMatch = trimmed.match(/^([^|\-]+?)\s*(?<!-)(-->|---|->(?![>])|<--|-\.->|==>)\s*(?:\|([^|]+)\|)?\s*(.+)$/);
    if (edgeMatch) {
      let left = fixNodeId(edgeMatch[1]);
      const arrow = edgeMatch[2];
      const label = edgeMatch[3] ? edgeMatch[3].trim() : undefined;
      let right = fixNodeId(edgeMatch[4]);

      return label ? `${left} ${arrow}|${label}| ${right}` : `${left} ${arrow} ${right}`;
    }

    return line;
  });

  return lines.join("\n");
}

function prepareChartSource(rawChart: string): { primary: string; fallback?: string } {
  let cleaned = rawChart.trim();

  if (cleaned.startsWith("```mermaid")) {
    cleaned = cleaned.substring(10).replace(/```$/, "").trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3).replace(/```$/, "").trim();
  }

  if (!cleaned) return { primary: "" };

  const normalized = normalizeMermaidSource(cleaned);

  const lower = normalized.toLowerCase();
  const knownKeywords = [
    "graph", "flowchart", "sequencediagram", "classdiagram", "statediagram",
    "erdiagram", "gantt", "pie", "gitgraph", "mindmap", "timeline",
    "zenuml", "sankey", "xychart", "block", "architecture", "kanban",
    "packet", "c4context", "requirement", "%%"
  ];

  const firstWord = lower.split(/\s+/)[0] || "";
  const hasKeyword = knownKeywords.some((kw) => firstWord.startsWith(kw));

  if (hasKeyword) {
    return { primary: cleaned, fallback: normalized };
  } else {
    return {
      primary: cleaned,
      fallback: `graph TD\n${normalized}`,
    };
  }
}

interface MermaidDiagramProps {
  chart: string;
  isStreaming?: boolean;
}

const renderContainerStyle: React.CSSProperties = {
  position: "absolute",
  left: "-10000px",
  top: "0px",
  width: "800px",
  minWidth: "600px",
  height: "auto",
  overflow: "hidden",
  visibility: "hidden",
  pointerEvents: "none",
};

export function MermaidDiagram({ chart, isStreaming = false }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [showCode, setShowCode] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const cleanChart = chart.trim();

  useEffect(() => {
    console.log("[MermaidDiagram] svg state changed:", {
      hasSvg: !!svg,
      length: svg?.length,
    });
  }, [svg]);

  useEffect(() => {
    let isCancelled = false;

    if (!cleanChart) {
      setSvg(null);
      setError(false);
      return;
    }

    // BUG 1: While streaming, NEVER call mermaid.parse() or mermaid.render()
    if (isStreaming) {
      return;
    }

    ensureMermaidInitialized();

    const renderDiagram = async () => {
      const { primary, fallback } = prepareChartSource(cleanChart);
      const container = containerRef.current || undefined;

      try {
        let chartToRender = primary;
        let renderId = `mermaid-${Math.random().toString(36).substring(2, 9)}-${Date.now()}`;
        console.log("[MermaidDiagram] Render starting for ID:", renderId);

        let result;
        try {
          result = await mermaid.render(renderId, primary, container);
        } catch (primaryErr) {
          if (fallback && fallback !== primary) {
            console.log("[MermaidDiagram] Primary render failed, attempting fallback source");
            renderId = `mermaid-${Math.random().toString(36).substring(2, 9)}-${Date.now()}`;
            result = await mermaid.render(renderId, fallback, container);
            chartToRender = fallback;
          } else {
            throw primaryErr;
          }
        }

        console.log("[MermaidDiagram] Render completed for ID:", renderId);
        console.log("[MermaidDiagram] SVG returned, length:", result?.svg?.length);

        if (!result?.svg) {
          throw new Error("Mermaid returned no SVG");
        }

        if (!isCancelled) {
          console.log("[MermaidDiagram] BEFORE setSvg", {
            svgLength: result?.svg?.length,
          });
          setSvg(result.svg);
          console.log("[MermaidDiagram] AFTER setSvg");
          setError(false);
        }
      } catch (err: any) {
        if (!isCancelled) {
          const errObj = {
            message: err?.message || (err instanceof Error ? err.message : String(err)),
            stack: err?.stack || (err instanceof Error ? err.stack : undefined),
            str: String(err),
            json: (() => {
              try { return JSON.stringify(err); } catch { return undefined; }
            })(),
            originalChart: cleanChart,
            isStreaming,
          };
          console.error("[MermaidDiagram] Mermaid error:", errObj);
          setError(true);
          setSvg(null);
        }
      }
    };

    renderDiagram();

    return () => {
      isCancelled = true;
    };
  }, [cleanChart, isStreaming]);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(cleanChart);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Render stable fallback UI while streaming or if syntax is invalid / source view toggled
  if (isStreaming || error || showCode) {
    return (
      <div className="my-4 rounded-xl border border-white/10 bg-[#18181b] overflow-hidden shadow-md min-h-[140px] flex flex-col justify-between relative">
        <div ref={containerRef} style={renderContainerStyle} aria-hidden="true" />
        <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10 text-xs font-mono text-gray-400">
          <span className="flex items-center gap-1.5 text-indigo-400 font-medium">
            <Code className="w-3.5 h-3.5" />
            mermaid {isStreaming ? "(generating...)" : "(source)"}
          </span>
          <div className="flex items-center gap-2">
            {!isStreaming && !error && (
              <button
                type="button"
                onClick={() => setShowCode(false)}
                className="text-gray-400 hover:text-white transition-colors cursor-pointer"
              >
                View Diagram
              </button>
            )}
            <button
              type="button"
              onClick={handleCopyCode}
              className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors cursor-pointer"
              title="Copy code"
            >
              {copied ? (
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
        </div>

        {isStreaming && (
          <div className="px-4 pt-3 text-xs text-indigo-300/80 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
            <span>Diagram is still being generated...</span>
          </div>
        )}

        <pre className="p-4 text-xs font-mono text-gray-300 overflow-x-auto">
          <code>{cleanChart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-4 p-6 rounded-xl border border-white/10 bg-[#18181b] flex items-center justify-center text-xs text-gray-400 font-mono min-h-[140px] relative">
        <div ref={containerRef} style={renderContainerStyle} aria-hidden="true" />
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
          <span>Rendering diagram...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="my-4 rounded-xl border border-white/10 bg-black/40 shadow-md min-h-[140px] flex flex-col overflow-hidden relative">
      <div ref={containerRef} style={renderContainerStyle} aria-hidden="true" />
      <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10 text-xs font-mono text-gray-400 shrink-0">
        <span className="text-indigo-400 font-semibold uppercase tracking-wider">Diagram</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowCode(true)}
            className="text-gray-400 hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
          >
            <Code className="w-3.5 h-3.5" />
            <span className="font-sans font-medium">Source</span>
          </button>
          <button
            type="button"
            onClick={handleCopyCode}
            className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors cursor-pointer"
            title="Copy diagram source"
          >
            {copied ? (
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
      </div>
      {svg && (
        <div className="p-4 overflow-x-auto w-full flex-1 flex justify-center items-center">
          <div
            className="min-w-max flex justify-center items-center [&_svg]:max-w-none [&_svg]:block"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </div>
  );
}


