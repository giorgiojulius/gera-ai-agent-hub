import { Code2, Download, Eye, MonitorPlay, type LucideIcon } from "lucide-react";
import { memo, useState } from "react";

import { downloadText } from "@/lib/artifacts";
import { cn } from "@/lib/utils";

import { ArtifactLightbox, ArtifactShell, ShellCopyButton, ShellExpandButton, ShellIconButton } from "./ArtifactShell";
import { CodeBlock } from "./CodeBlock";

const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";

function wrapSvgDocument(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:96vw;max-height:96vh}</style></head><body>${code}</body></html>`;
}

/**
 * Renders ```html / ```svg fences in a sandboxed iframe with
 * Preview/Code tabs, fullscreen dialog, copy, and download.
 */
export const HtmlArtifact = memo(function HtmlArtifact({
  code,
  streaming,
  isSvg = false,
}: {
  code: string;
  streaming: boolean;
  isSvg?: boolean;
}) {
  const [tab, setTab] = useState<"auto" | "preview" | "code">("auto");
  const [expanded, setExpanded] = useState<boolean>(false);
  const active: "preview" | "code" = tab === "auto" ? (streaming ? "code" : "preview") : tab;
  const showPreview = active === "preview" && !streaming;
  const doc = isSvg ? wrapSvgDocument(code) : code;

  return (
    <ArtifactShell
      icon={MonitorPlay}
      title={isSvg ? "Vector graphic" : "Live preview"}
      badge={isSvg ? "svg" : "html"}
      actions={
        <>
          <div className="mr-1 flex items-center rounded-lg bg-foreground/5 p-0.5">
            <TabButton active={showPreview} onClick={() => setTab("preview")} icon={Eye} label="Preview" />
            <TabButton active={!showPreview} onClick={() => setTab("code")} icon={Code2} label="Code" />
          </div>
          <ShellExpandButton onClick={() => setExpanded(true)} />
          <ShellIconButton
            icon={Download}
            label={isSvg ? "Download SVG" : "Download HTML"}
            onClick={() =>
              downloadText(isSvg ? "artifact.svg" : "artifact.html", code, isSvg ? "image/svg+xml" : "text/html")
            }
          />
          <ShellCopyButton text={code} />
        </>
      }
    >
      {showPreview ? (
        <iframe srcDoc={doc} sandbox={SANDBOX} title="Artifact preview" className="h-[380px] w-full border-0 bg-white" />
      ) : (
        <>
          {streaming ? (
            <p className="border-b border-border/60 px-3.5 py-1.5 text-[11px] text-muted-foreground">
              Live preview opens when the code finishes streaming.
            </p>
          ) : null}
          <CodeBlock code={code} language={isSvg ? "svg" : "html"} streaming={streaming} frameless />
        </>
      )}
      <ArtifactLightbox
        open={expanded}
        onOpenChange={setExpanded}
        icon={MonitorPlay}
        title={isSvg ? "Vector graphic" : "Live preview"}
        badge={isSvg ? "svg" : "html"}
      >
        <iframe
          srcDoc={doc}
          sandbox={SANDBOX}
          title="Expanded artifact preview"
          className="h-full w-full border-0 bg-white"
        />
      </ArtifactLightbox>
    </ArtifactShell>
  );
});

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}
