import { Code2, Download, Loader2, Workflow } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { downloadText } from "@/lib/artifacts";
import { isStaleChunkError } from "@/lib/stale-chunk";

import { ArtifactLightbox, ArtifactShell, ShellCopyButton, ShellExpandButton, ShellIconButton } from "./ArtifactShell";
import { CodeBlock } from "./CodeBlock";

let initialized = false;
let renderSeq = 0;

type MermaidApi = typeof import("mermaid").default;

/**
 * Loads mermaid's single-file bundle (side effect: sets `globalThis.mermaid`).
 * The ESM entry dynamically imports ~30 per-diagram chunks, which makes the
 * deploy uploader flaky; the bundled build keeps it to one lazy chunk.
 */
async function loadMermaid(): Promise<MermaidApi> {
  await import("mermaid/dist/mermaid.min.js");
  const api = (globalThis as unknown as { mermaid?: MermaidApi }).mermaid;
  if (!api) {
    throw new Error("Mermaid failed to initialize.");
  }
  return api;
}

/** Lazy-loads mermaid on first diagram and renders to an SVG string. */
async function renderMermaid(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      fontFamily: "'Golos Text', ui-sans-serif, system-ui, sans-serif",
      theme: "base",
      themeVariables: {
        background: "#FBF8FA",
        primaryColor: "#ECDEE6",
        primaryTextColor: "#241820",
        primaryBorderColor: "#A87E96",
        secondaryColor: "#F1E7ED",
        tertiaryColor: "#F6F0F3",
        lineColor: "#7E6A77",
        textColor: "#3B2C35",
        fontSize: "14px",
      },
    });
    initialized = true;
  }
  renderSeq += 1;
  const { svg } = await mermaid.render(`gera-mermaid-${renderSeq}`, code);
  return svg;
}

/**
 * Renders ```mermaid fences as diagrams. While streaming it re-renders
 * with a debounce and silently keeps the last good frame.
 */
export const MermaidArtifact = memo(function MermaidArtifact({ code, streaming }: { code: string; streaming: boolean }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);

  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        renderMermaid(trimmed)
          .then((markup) => {
            if (!cancelled) {
              setSvg(markup);
              setError(null);
            }
          })
          .catch((err: unknown) => {
            if (!cancelled && !streaming) {
              // A chunk 404 means the app deployed mid-session (or the network
              // dropped) — the raw browser message is useless to a reader.
              setError(
                isStaleChunkError(err)
                  ? "The diagram renderer failed to load — the app updated in the background or the connection dropped. Reload the page to retry."
                  : err instanceof Error
                    ? err.message
                    : "Diagram failed to render.",
              );
            }
          });
      },
      streaming ? 400 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, streaming]);

  return (
    <ArtifactShell
      icon={Workflow}
      title="Diagram"
      badge="mermaid"
      actions={
        <>
          <ShellIconButton
            icon={Code2}
            label={showCode ? "Hide source" : "View source"}
            active={showCode}
            onClick={() => setShowCode((value) => !value)}
          />
          {svg ? <ShellExpandButton onClick={() => setExpanded(true)} /> : null}
          <ShellIconButton
            icon={Download}
            label="Download SVG"
            onClick={() => {
              if (svg) {
                downloadText("diagram.svg", svg, "image/svg+xml");
              }
            }}
          />
          <ShellCopyButton text={code} />
        </>
      }
    >
      {svg ? (
        <div
          className="overflow-x-auto bg-[#FBF8FA] p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : error ? (
        <>
          <p className="break-words border-b border-border/60 px-3.5 py-2 text-xs text-destructive">{error}</p>
          <CodeBlock code={code} frameless />
        </>
      ) : (
        <div className="flex h-[160px] items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-ember" />
          Rendering diagram…
        </div>
      )}
      {showCode && svg ? <CodeBlock code={code} frameless /> : null}
      <ArtifactLightbox open={expanded} onOpenChange={setExpanded} icon={Workflow} title="Diagram" badge="mermaid">
        <div
          className="grid min-h-full w-full place-items-center bg-[#FBF8FA] p-4 sm:p-8 [&_svg]:h-auto [&_svg]:w-full [&_svg]:!max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </ArtifactLightbox>
    </ArtifactShell>
  );
});
