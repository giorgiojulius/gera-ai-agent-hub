// Vault-aware media elements + a Grok Imagine-style fullscreen viewer.
// Message media may be an `idb:` ref (disk-backed blob in the media vault),
// a remote URL, or a legacy inline data URL — these components resolve
// whatever they get and keep the giant base64 strings out of React state.
// Lazy loading + metadata-only preload keep decode memory low in long threads.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { downloadOrOpenMedia, openMediaInNewTab } from "@/lib/media-actions";
import { cachedMediaUrl, isVaultRef, resolveMediaUrl } from "@/lib/media-vault";
import { cn } from "@/lib/utils";

type MediaState = { url: string | null; missing: boolean };

/** Resolves a media source (ref / URL / data URL) to something renderable. */
export function useMediaUrl(source: string): MediaState {
  const [state, setState] = useState<MediaState>(() => ({
    url: cachedMediaUrl(source),
    missing: false,
  }));

  useEffect(() => {
    let cancelled = false;
    const cached = cachedMediaUrl(source);
    setState({ url: cached, missing: false });
    if (cached !== null || !isVaultRef(source)) {
      return;
    }
    void resolveMediaUrl(source).then((url) => {
      if (!cancelled) {
        setState({ url, missing: url === null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return state;
}

export function MediaImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const { url, missing } = useMediaUrl(src);
  if (missing) {
    return (
      <div
        className={cn(
          "flex min-h-20 items-center justify-center gap-1.5 bg-muted/60 text-[11px] text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="h-3.5 w-3.5" />
        Image unavailable
      </div>
    );
  }
  if (!url) {
    return <div aria-hidden className={cn("min-h-20 animate-pulse bg-muted/60", className)} />;
  }
  return <img src={url} alt={alt} loading="lazy" decoding="async" className={className} />;
}

export function MediaVideo({ src, className }: { src: string; className?: string }) {
  const { url, missing } = useMediaUrl(src);
  if (missing) {
    return (
      <div
        className={cn(
          "flex min-h-20 items-center justify-center gap-1.5 bg-muted/60 text-[11px] text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="h-3.5 w-3.5" />
        Video unavailable
      </div>
    );
  }
  if (!url) {
    return <div aria-hidden className={cn("min-h-24 animate-pulse bg-muted/60", className)} />;
  }
  return <video src={url} controls preload="metadata" className={className} />;
}

export function MediaAudio({ src, className }: { src: string; className?: string }) {
  const { url, missing } = useMediaUrl(src);
  if (missing) {
    return (
      <div className={cn("rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground", className)}>
        Audio unavailable
      </div>
    );
  }
  if (!url) {
    return <div aria-hidden className={cn("h-10 animate-pulse rounded-lg bg-muted/60", className)} />;
  }
  return <audio controls preload="metadata" src={url} className={className} />;
}

/** Circular glass action chip — Grok Imagine style. */
function GlassIconButton({
  label,
  onClick,
  tone = "media",
  size = "sm",
  children,
}: {
  label: string;
  onClick: () => void;
  /** media = dark chip over a thumbnail; viewer = white glass on the black viewer; plain = light card chip. */
  tone?: "media" | "viewer" | "plain";
  size?: "sm" | "md";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full transition-all active:scale-90 focus-visible:outline-none focus-visible:ring-2",
        size === "sm" ? "h-7 w-7" : "h-10 w-10",
        tone === "media" && "bg-black/55 text-white shadow-sm backdrop-blur-md hover:bg-black/75 focus-visible:ring-white/60",
        tone === "viewer" && "bg-white/10 text-white backdrop-blur-md hover:bg-white/20 focus-visible:ring-white/60",
        tone === "plain" &&
          "border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring",
      )}
    >
      {children}
    </button>
  );
}

export type LightboxItem = {
  src: string;
  kind: "image" | "video";
  /** Base file name used for downloads. */
  name: string;
  caption?: string;
};

function LightboxThumb({ item, active, onSelect }: { item: LightboxItem; active: boolean; onSelect: () => void }) {
  const { url } = useMediaUrl(item.src);
  return (
    <button
      type="button"
      aria-label={`Show ${item.name}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className={cn(
        "relative h-12 w-12 shrink-0 overflow-hidden rounded-xl transition-all",
        active ? "ring-2 ring-white" : "opacity-55 hover:opacity-100",
      )}
    >
      {url ? (
        item.kind === "video" ? (
          <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        )
      ) : (
        <span aria-hidden className="block h-full w-full animate-pulse bg-white/10" />
      )}
    </button>
  );
}

/**
 * Grok Imagine-style fullscreen media viewer: near-black blurred backdrop,
 * floating glass controls, arrow navigation and a thumbnail rail for
 * galleries. Escape / backdrop click closes; ← → move between items.
 */
export function MediaLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: LightboxItem[];
  index: number | null;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}) {
  const count = items.length;
  const open = index !== null && index >= 0 && index < count;
  const item = open ? items[index] : null;
  const { url } = useMediaUrl(item?.src ?? "");

  const step = (delta: number) => {
    if (index === null || count < 2) {
      return;
    }
    onIndexChange((index + delta + count) % count);
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          onClose();
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/95 backdrop-blur-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          onClick={onClose}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              step(1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              step(-1);
            }
          }}
          className="fixed inset-0 z-[60] flex select-none flex-col outline-none duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">{item?.name ?? "Media preview"}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Fullscreen media viewer. Use arrow keys to navigate, Escape to close.
          </DialogPrimitive.Description>

          <div
            className="relative z-10 flex items-center justify-between gap-2 p-3 sm:p-4"
            onClick={(event) => event.stopPropagation()}
          >
            {count > 1 && index !== null ? (
              <span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium tabular-nums text-white/90 backdrop-blur-md">
                {index + 1} / {count}
              </span>
            ) : (
              <span aria-hidden />
            )}
            <div className="flex items-center gap-2">
              {item ? (
                <>
                  <GlassIconButton
                    tone="viewer"
                    size="md"
                    label="Download"
                    onClick={() => void downloadOrOpenMedia(item.src, item.name)}
                  >
                    <Download className="h-5 w-5" />
                  </GlassIconButton>
                  <GlassIconButton
                    tone="viewer"
                    size="md"
                    label="Open in new tab"
                    onClick={() => void openMediaInNewTab(item.src)}
                  >
                    <ExternalLink className="h-5 w-5" />
                  </GlassIconButton>
                </>
              ) : null}
              <GlassIconButton tone="viewer" size="md" label="Close" onClick={onClose}>
                <X className="h-5 w-5" />
              </GlassIconButton>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center px-4 sm:px-20">
            {item && url ? (
              item.kind === "video" ? (
                <video
                  key={item.src}
                  src={url}
                  controls
                  autoPlay
                  playsInline
                  onClick={(event) => event.stopPropagation()}
                  className="max-h-full max-w-full rounded-2xl shadow-2xl outline-none"
                />
              ) : (
                <img
                  key={item.src}
                  src={url}
                  alt={item.caption ?? item.name}
                  decoding="async"
                  onClick={(event) => event.stopPropagation()}
                  className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl"
                />
              )
            ) : item ? (
              <div aria-hidden className="h-48 w-48 animate-pulse rounded-3xl bg-white/10" />
            ) : null}
          </div>

          {count > 1 ? (
            <>
              <button
                type="button"
                aria-label="Previous"
                onClick={(event) => {
                  event.stopPropagation();
                  step(-1);
                }}
                className="absolute left-3 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md transition-all hover:bg-white/20 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:left-5"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                aria-label="Next"
                onClick={(event) => {
                  event.stopPropagation();
                  step(1);
                }}
                className="absolute right-3 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md transition-all hover:bg-white/20 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:right-5"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          ) : null}

          <div
            className="relative z-10 flex flex-col items-center gap-2.5 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:pb-5"
            onClick={(event) => event.stopPropagation()}
          >
            {item?.caption ? (
              <p className="max-w-xl truncate text-center text-xs text-white/60">{item.caption}</p>
            ) : null}
            {count > 1 && index !== null ? (
              <div className="flex max-w-full gap-1.5 overflow-x-auto rounded-2xl bg-white/5 p-1.5 backdrop-blur-md">
                {items.map((thumb, thumbIndex) => (
                  <LightboxThumb
                    key={`${thumb.src.slice(0, 40)}-${thumbIndex}`}
                    item={thumb}
                    active={thumbIndex === index}
                    onSelect={() => onIndexChange(thumbIndex)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Clickable image tile with hover glass actions. Span-based so it stays valid
 * inside markdown paragraphs; `group/media` avoids clashing with outer
 * `group` wrappers (e.g. the chat bubble hover controls).
 */
function ImageSurface({
  src,
  alt,
  name,
  onOpen,
  hideActions = false,
  className,
  imgClassName,
}: {
  src: string;
  alt: string;
  name: string;
  onOpen: () => void;
  hideActions?: boolean;
  className?: string;
  imgClassName?: string;
}) {
  const { url, missing } = useMediaUrl(src);
  if (missing) {
    return (
      <span
        className={cn(
          "flex min-h-20 items-center justify-center gap-1.5 overflow-hidden bg-muted/60 text-[11px] text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="h-3.5 w-3.5" />
        Image unavailable
      </span>
    );
  }
  if (!url) {
    return <span aria-hidden className={cn("block min-h-20 animate-pulse overflow-hidden bg-muted/60", className)} />;
  }
  return (
    <span className={cn("group/media relative block overflow-hidden", className)}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${name} fullscreen`}
        className="block h-full w-full cursor-zoom-in focus-visible:outline-none"
      >
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          className={cn("block h-auto w-full", imgClassName)}
        />
      </button>
      {!hideActions ? (
        <span className="absolute right-2 top-2 flex gap-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within/media:opacity-100 sm:group-hover/media:opacity-100">
          <GlassIconButton label="Download" onClick={() => void downloadOrOpenMedia(src, name)}>
            <Download className="h-3.5 w-3.5" />
          </GlassIconButton>
          <GlassIconButton label="Open in new tab" onClick={() => void openMediaInNewTab(src)}>
            <ExternalLink className="h-3.5 w-3.5" />
          </GlassIconButton>
          <GlassIconButton label="Fullscreen" onClick={onOpen}>
            <Maximize2 className="h-3.5 w-3.5" />
          </GlassIconButton>
        </span>
      ) : null}
    </span>
  );
}

/** Single image with tap-to-fullscreen and download / open actions. */
export function MediaImageCard({
  src,
  alt,
  downloadName,
  caption,
  hideActions = false,
  className,
  imgClassName,
}: {
  src: string;
  alt: string;
  downloadName?: string;
  caption?: string;
  hideActions?: boolean;
  className?: string;
  imgClassName?: string;
}) {
  const [open, setOpen] = useState<boolean>(false);
  const name = (downloadName ?? alt).trim() || "gera-image";
  const items = useMemo<LightboxItem[]>(() => [{ src, kind: "image", name, caption }], [src, name, caption]);
  return (
    <>
      <ImageSurface
        src={src}
        alt={alt}
        name={name}
        onOpen={() => setOpen(true)}
        hideActions={hideActions}
        className={className}
        imgClassName={imgClassName}
      />
      <MediaLightbox
        items={items}
        index={open ? 0 : null}
        onIndexChange={() => undefined}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * Gallery grid for generated images — one shared viewer with ←/→ and thumbnails.
 * Sized like Grok/ChatGPT chat cards: a single image stays a compact card,
 * multiples pack into a tight 2-up grid of square crops; the lightbox always
 * shows the full uncropped image.
 */
export function MediaImageGrid({
  images,
  baseName = "gera-image",
  className,
}: {
  images: string[];
  baseName?: string;
  className?: string;
}) {
  const [viewer, setViewer] = useState<number | null>(null);
  const multiple = images.length > 1;
  const items = useMemo<LightboxItem[]>(
    () => images.map((src, imageIndex) => ({ src, kind: "image" as const, name: `${baseName}-${imageIndex + 1}` })),
    [images, baseName],
  );
  return (
    <>
      <div className={cn("grid gap-2.5", multiple ? "max-w-[540px] grid-cols-2" : "max-w-[400px]", className)}>
        {images.map((src, imageIndex) => (
          <ImageSurface
            key={`${src.slice(0, 48)}-${imageIndex}`}
            src={src}
            alt={`Generated image ${imageIndex + 1}`}
            name={`${baseName}-${imageIndex + 1}`}
            onOpen={() => setViewer(imageIndex)}
            className="rounded-2xl border border-border"
            imgClassName={multiple ? "aspect-square w-full object-cover" : "max-h-[500px] w-full object-cover"}
          />
        ))}
      </div>
      <MediaLightbox items={items} index={viewer} onIndexChange={setViewer} onClose={() => setViewer(null)} />
    </>
  );
}

/** Video player with fullscreen viewer, download and open-in-tab actions. */
export function MediaVideoCard({
  src,
  downloadName,
  className,
}: {
  src: string;
  downloadName?: string;
  className?: string;
}) {
  const { url, missing } = useMediaUrl(src);
  const [open, setOpen] = useState<boolean>(false);
  const name = downloadName ?? "gera-video";
  const items = useMemo<LightboxItem[]>(() => [{ src, kind: "video", name }], [src, name]);
  if (missing) {
    return (
      <div
        className={cn(
          "flex min-h-20 items-center justify-center gap-1.5 bg-muted/60 text-[11px] text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="h-3.5 w-3.5" />
        Video unavailable
      </div>
    );
  }
  if (!url) {
    return <div aria-hidden className={cn("min-h-24 animate-pulse bg-muted/60", className)} />;
  }
  return (
    <>
      <div className={cn("group/media relative overflow-hidden", className)}>
        <video src={url} controls preload="metadata" playsInline className="block w-full" />
        <div className="pointer-events-none absolute right-2 top-2 z-10">
          <span className="pointer-events-auto flex gap-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within/media:opacity-100 sm:group-hover/media:opacity-100">
            <GlassIconButton label="Fullscreen" onClick={() => setOpen(true)}>
              <Maximize2 className="h-3.5 w-3.5" />
            </GlassIconButton>
            <GlassIconButton label="Download" onClick={() => void downloadOrOpenMedia(src, name)}>
              <Download className="h-3.5 w-3.5" />
            </GlassIconButton>
            <GlassIconButton label="Open in new tab" onClick={() => void openMediaInNewTab(src)}>
              <ExternalLink className="h-3.5 w-3.5" />
            </GlassIconButton>
          </span>
        </div>
      </div>
      <MediaLightbox
        items={items}
        index={open ? 0 : null}
        onIndexChange={() => undefined}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** Audio row with download and open-in-tab chips. */
export function MediaAudioCard({
  src,
  downloadName,
  className,
}: {
  src: string;
  downloadName?: string;
  className?: string;
}) {
  const { url, missing } = useMediaUrl(src);
  const name = downloadName ?? "gera-audio";
  if (missing) {
    return (
      <div className={cn("rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground", className)}>
        Audio unavailable
      </div>
    );
  }
  if (!url) {
    return <div aria-hidden className={cn("h-12 animate-pulse rounded-2xl bg-muted/60", className)} />;
  }
  return (
    <div className={cn("flex items-center gap-1.5 rounded-2xl border border-border bg-card py-1.5 pl-1.5 pr-2", className)}>
      <audio controls preload="metadata" src={url} className="h-10 min-w-0 flex-1" />
      <GlassIconButton tone="plain" label="Download audio" onClick={() => void downloadOrOpenMedia(src, name)}>
        <Download className="h-3.5 w-3.5" />
      </GlassIconButton>
      <GlassIconButton tone="plain" label="Open in new tab" onClick={() => void openMediaInNewTab(src)}>
        <ExternalLink className="h-3.5 w-3.5" />
      </GlassIconButton>
    </div>
  );
}
