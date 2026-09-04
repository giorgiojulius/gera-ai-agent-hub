// Binary parts an MCP tool returned, shown on its record: image thumbnails
// (the same images also land in the message's media grid) and audio/blob
// files with a Save button. Sources are vault refs, data URLs or remote URLs —
// VaultMedia resolves them; Save downloads the bytes (or opens them when the
// browser blocks downloads).
import { Download, FileAudio, FileIcon, Loader2 } from "lucide-react";
import { useState } from "react";

import { MediaImg } from "@/components/gera/VaultMedia";
import { downloadOrOpenMedia } from "@/lib/media-actions";
import { TID } from "@/lib/testids";
import type { ToolCallFile } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Human size for a file chip; "" when unknown. */
export function describeFileSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function FileChip({ file }: { file: ToolCallFile }) {
  const [saving, setSaving] = useState<boolean>(false);
  const Icon = file.mime.startsWith("audio/") ? FileAudio : FileIcon;
  const size = describeFileSize(file.bytes);
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await downloadOrOpenMedia(file.url, file.name);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      data-testid={TID.messageToolFile}
      className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-2 py-1 text-[11px]"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{file.name}</span>
      <span className="shrink-0 text-muted-foreground">
        {file.mime}
        {size ? ` · ${size}` : ""}
      </span>
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-ember hover:bg-ember/10 disabled:opacity-60"
        aria-label={`Save ${file.name}`}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
        Save
      </button>
    </div>
  );
}

/** Thumbnails + file chips under a tool record; renders nothing when the record carries no media. */
export function ToolCallMedia({
  images,
  files,
  className,
}: {
  images?: string[];
  files?: ToolCallFile[];
  className?: string;
}) {
  const hasImages = Boolean(images && images.length > 0);
  const hasFiles = Boolean(files && files.length > 0);
  if (!hasImages && !hasFiles) {
    return null;
  }
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {hasImages ? (
        <div className="flex flex-wrap gap-1.5" data-testid={TID.messageToolImages}>
          {images?.map((source, index) => (
            <MediaImg
              key={`${source.slice(0, 48)}-${index}`}
              src={source}
              alt={`Tool result image ${index + 1}`}
              className="h-14 w-14 rounded-lg border border-border/70 object-cover"
            />
          ))}
        </div>
      ) : null}
      {hasFiles ? <div className="flex flex-wrap gap-1.5">{files?.map((file, index) => <FileChip key={`${file.url.slice(0, 48)}-${index}`} file={file} />)}</div> : null}
    </div>
  );
}
