import { createContext, isValidElement, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ResearchSource } from "@/lib/types";

import { ActionArtifact } from "@/components/gera/artifacts/ActionArtifact";
import { ChartArtifact } from "@/components/gera/artifacts/ChartArtifact";
import { CodeBlock } from "@/components/gera/artifacts/CodeBlock";
import { HtmlArtifact } from "@/components/gera/artifacts/HtmlArtifact";
import { MapArtifact } from "@/components/gera/artifacts/MapArtifact";
import { MermaidArtifact } from "@/components/gera/artifacts/MermaidArtifact";
import { MediaImageCard } from "@/components/gera/VaultMedia";
import { cn } from "@/lib/utils";

/**
 * Whether the current message is still streaming, shared through context
 * instead of closures inside the components map. This keeps the map ONE
 * stable module-level object — recreating it per render made React remount
 * every fence artifact on every streamed token, so charts/maps/diagrams
 * kept resetting and only settled after the whole answer finished.
 */
const StreamingContext = createContext<boolean>(false);

function flattenText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(flattenText).join("");
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return flattenText(props.children);
  }
  return "";
}

/** Pulls the language tag and raw text out of a rendered fence. */
function fenceInfo(children: ReactNode): { language: string; code: string } {
  let language = "";
  let target: ReactNode = children;
  const child = Array.isArray(children) ? children[0] : children;
  if (isValidElement(child)) {
    const props = child.props as { className?: string; children?: ReactNode };
    const match = /language-([\w+-]+)/.exec(props.className ?? "");
    if (match) {
      language = match[1].toLowerCase();
    }
    target = props.children;
  }
  return { language, code: flattenText(target).replace(/\n$/, "") };
}

/** Routes a fenced block to the matching artifact card by language tag. */
function FencedBlock({ children }: { children?: ReactNode }) {
  const streaming = useContext(StreamingContext);
  const { language, code } = fenceInfo(children);
  if (!code.trim()) {
    return null;
  }
  if (language === "action" || language === "actions" || language === "hub") {
    return <ActionArtifact code={code} streaming={streaming} />;
  }
  if (language === "chart" || language === "graph" || language === "plot") {
    return <ChartArtifact code={code} streaming={streaming} />;
  }
  if (language === "map" || language === "geo" || language === "geojson" || language === "locations") {
    return <MapArtifact code={code} streaming={streaming} />;
  }
  if (language === "mermaid") {
    return <MermaidArtifact code={code} streaming={streaming} />;
  }
  if (language === "html") {
    return <HtmlArtifact code={code} streaming={streaming} />;
  }
  if (language === "svg" || (language === "xml" && code.trimStart().startsWith("<svg"))) {
    return <HtmlArtifact code={code} streaming={streaming} isSvg />;
  }
  return <CodeBlock code={code} language={language} streaming={streaming} />;
}

/**
 * Turns bare [n] citation markers into markdown links against the message's
 * source list. Fenced blocks and inline code are left untouched. Only numbers
 * the ledger actually assigned get linked — anything else stays plain text.
 */
function linkCitations(text: string, sources: ResearchSource[]): string {
  if (sources.length === 0 || !text.includes("[")) {
    return text;
  }
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((fencePart, fenceIndex) => {
      if (fenceIndex % 2 === 1) {
        return fencePart;
      }
      return fencePart
        .split(/(`[^`\n]*`)/)
        .map((piece, pieceIndex) => {
          if (pieceIndex % 2 === 1) {
            return piece;
          }
          return piece
            .replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})+)\]/g, (_match, group: string) =>
              group
                .split(",")
                .map((numText) => `[${numText.trim()}]`)
                .join(""),
            )
            .replace(/\[(\d{1,3})\](?!\(|:)/g, (match, numText: string) => {
              const index = Number(numText);
              const source = index >= 1 && index <= sources.length ? sources[index - 1] : undefined;
              return source ? `[${numText}](${source.url})` : match;
            });
        })
        .join("");
    })
    .join("");
}

/** Built once at module scope so component identities never change between renders. */
const MD_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const label = flattenText(children).trim();
    // Citation pill: a link whose visible text is just a small number.
    if (href && /^\d{1,3}$/.test(label)) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={href}
          className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-md bg-ember/10 px-1 align-[0.18em] text-[10px] font-semibold leading-none text-ember no-underline transition-colors hover:bg-ember/20"
        >
          {label}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-ember underline-offset-2 hover:underline">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) =>
    typeof src === "string" && src.length > 0 ? (
      <MediaImageCard
        src={src}
        alt={alt ?? ""}
        caption={alt?.trim() ? alt : undefined}
        downloadName={alt?.trim() ? alt : "image"}
        className="my-3 w-fit max-w-[420px] rounded-2xl border border-border"
        imgClassName="max-h-[360px] w-auto max-w-full"
      />
    ) : null,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-2xl border border-border bg-card shadow-sm">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  pre: FencedBlock,
  code: ({ className: codeClass, children }) => {
    const isBlock = typeof codeClass === "string" && codeClass.includes("language-");
    if (isBlock) {
      return <code className={codeClass}>{children}</code>;
    }
    return (
      <code className="rounded-md bg-ember/10 px-1.5 py-0.5 font-mono text-[0.85em] text-ember">{children}</code>
    );
  },
};

type RemarkPlugins = NonNullable<import("react-markdown").Options["remarkPlugins"]>;

/**
 * GFM with single-tilde strikethrough DISABLED. Reports are full of
 * approximations ("~30%") and numeric ranges ("5~7"); with the default
 * singleTilde the parser pairs two of those up and strikes out everything
 * between them. Real ~~strikethrough~~ still works.
 */
const REMARK_PLUGINS: RemarkPlugins = [[remarkGfm, { singleTilde: false }]];

export const MarkdownBody = memo(function MarkdownBody({
  text,
  className,
  streaming = false,
  sources,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
  /** Citation targets: [n] markers in the text link to sources[n-1]. */
  sources?: ResearchSource[];
}) {
  const processed = useMemo(
    () => (sources && sources.length > 0 ? linkCitations(text, sources) : text),
    [text, sources],
  );
  return (
    <StreamingContext.Provider value={streaming}>
      <div className={cn("gera-md", className)}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
          {processed}
        </ReactMarkdown>
      </div>
    </StreamingContext.Provider>
  );
});
