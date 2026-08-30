import { Check, ChevronDown, ChevronsDownUp, Code2, Copy, Maximize2 } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import { ArtifactLightbox } from "./ArtifactShell";
import { cachedHighlighter, loadHighlighter, normalizeLanguage, type Highlighter } from "./highlighter";

/**
 * Dark code artifact with language header, copy button, lazy syntax
 * highlighting, and collapse for long snippets. `frameless` renders just
 * the code body (used inside other artifact shells).
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  streaming = false,
  frameless = false,
  full = false,
}: {
  code: string;
  language?: string;
  streaming?: boolean;
  frameless?: boolean;
  /** Fullscreen rendering: never collapse, show every line. */
  full?: boolean;
}) {
  const [copied, setCopied] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [fullscreen, setFullscreen] = useState<boolean>(false);
  const [highlighter, setHighlighter] = useState<Highlighter | null>(cachedHighlighter());

  useEffect(() => {
    if (highlighter || streaming) {
      return;
    }
    let cancelled = false;
    loadHighlighter()
      .then((loaded) => {
        if (!cancelled) {
          setHighlighter(loaded);
        }
      })
      .catch(() => {
        // highlighting is optional — plain text stays
      });
    return () => {
      cancelled = true;
    };
  }, [highlighter, streaming]);

  const lang = normalizeLanguage(language);
  const lineCount = useMemo(() => code.split("\n").length, [code]);
  const collapsible = !full && !streaming && lineCount > 24;
  const collapsed = collapsible && !expanded;
  const canHighlight = highlighter !== null && !streaming && lang.length > 0 && highlighter.languages.has(lang);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const body = (
    <div className={cn("relative", collapsed && "max-h-[380px] overflow-hidden")}>
      {canHighlight && highlighter ? (
        <highlighter.Component
          language={lang}
          style={highlighter.theme}
          customStyle={{
            margin: 0,
            padding: "14px 16px",
            background: "transparent",
            fontSize: 13,
            lineHeight: 1.65,
          }}
          codeTagProps={{
            style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
          }}
        >
          {code}
        </highlighter.Component>
      ) : (
        <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-[1.65] text-[#EFE8EC]">
          <code>{code}</code>
        </pre>
      )}
      {collapsed ? (
        <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-[#1F161C] via-[#1F161C]/90 to-transparent pb-3 pt-12">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-[#E5D9E0] backdrop-blur transition-colors hover:bg-white/10"
          >
            <ChevronDown className="h-3 w-3" />
            Show all {lineCount} lines
          </button>
        </div>
      ) : null}
    </div>
  );

  if (frameless) {
    return <div className="bg-[#1F161C]">{body}</div>;
  }

  return (
    <div className="gera-artifact my-3 overflow-hidden rounded-2xl border border-[#362A32] bg-[#1F161C] shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3.5 py-1.5">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[#A5939F]">
          {lang || "code"} · {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {collapsible && expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              title="Collapse"
              aria-label="Collapse"
              className="flex h-6 w-6 items-center justify-center rounded-md text-[#A5939F] transition-colors hover:bg-white/5 hover:text-[#EFE8EC]"
            >
              <ChevronsDownUp className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            title="Fullscreen"
            aria-label="Fullscreen"
            className="flex h-6 w-6 items-center justify-center rounded-md text-[#A5939F] transition-colors hover:bg-white/5 hover:text-[#EFE8EC]"
          >
            <Maximize2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={copy}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-[#A5939F] transition-colors hover:bg-white/5 hover:text-[#EFE8EC]"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {body}
      <ArtifactLightbox
        open={fullscreen}
        onOpenChange={setFullscreen}
        icon={Code2}
        title={lang || "Code"}
        badge={`${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
        dark
      >
        <CodeBlock code={code} language={language} frameless full />
      </ArtifactLightbox>
    </div>
  );
});
