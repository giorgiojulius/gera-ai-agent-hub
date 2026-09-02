import { toast } from "sonner";

/** `source` stamp of every message the served preview's shim posts to its embedder. */
export const PREVIEW_BRIDGE_SOURCE = "gera-preview";

/** Upper bound on browser-style tabs one docked preview may keep mounted. */
export const MAX_PREVIEW_TABS = 8;

export type PreviewBridgeMessage =
  | { type: "open"; url: string; target: string }
  | { type: "state"; href: string; title: string };

/** Where a popup requested by the sandboxed preview should go. */
export type PopupRoute =
  | { kind: "tab"; url: string }
  | { kind: "external"; url: string }
  | { kind: "blocked"; reason: "invalid-url" | "scheme" | "credentials" };

/**
 * Validates a cross-document message from an opaque-origin preview frame.
 * Only the documented shapes with string payloads pass; everything else is
 * treated as noise so a hostile build cannot smuggle richer structures in.
 */
export function parsePreviewBridgeMessage(data: unknown): PreviewBridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.source !== PREVIEW_BRIDGE_SOURCE) return null;
  if (record.type === "open" && typeof record.url === "string") {
    return {
      type: "open",
      url: record.url.slice(0, 4_096),
      target: typeof record.target === "string" ? record.target.slice(0, 64) : "_blank",
    };
  }
  if (record.type === "state" && typeof record.href === "string") {
    return {
      type: "state",
      href: record.href.slice(0, 4_096),
      title: typeof record.title === "string" ? record.title.trim().slice(0, 200) : "",
    };
  }
  return null;
}

/** Directory of the artifact root (`https://host/repo-preview/<id>/<cap>/`) without query/hash. */
export function previewBase(previewUrl: string): URL | null {
  try {
    const url = new URL(previewUrl);
    if (!url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

/**
 * Decides how to honour a popup from inside the preview: URLs on the preview's
 * own origin become panel tabs (root-relative paths an app assumed to live at
 * `/` are folded back under the artifact root, mirroring the Worker's HTML
 * rewrite, so nothing escapes the sandboxed namespace), other web origins open
 * as real browser tabs, and non-web schemes or embedded credentials are refused.
 */
export function routePreviewPopup(rawUrl: string, previewUrl: string): PopupRoute {
  const base = previewBase(previewUrl);
  let url: URL;
  try {
    url = new URL(rawUrl, base ?? undefined);
  } catch {
    return { kind: "blocked", reason: "invalid-url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "blocked", reason: "scheme" };
  if (url.username || url.password) return { kind: "blocked", reason: "credentials" };
  if (base && url.origin === base.origin) {
    if (url.pathname.startsWith(base.pathname)) return { kind: "tab", url: url.toString() };
    return { kind: "tab", url: `${base.href}${url.pathname.replace(/^\/+/, "")}${url.search}${url.hash}` };
  }
  return { kind: "external", url: url.toString() };
}

/** In-app route for the address bar and tab labels: the part after the artifact root. */
export function previewRoutePath(href: string | null | undefined, previewUrl: string): string {
  const base = previewBase(previewUrl);
  if (!href || !base) return "/";
  try {
    const url = new URL(href);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return "/";
    const rest = url.pathname.slice(base.pathname.length);
    const path = rest === "index.html" ? "/" : `/${rest}`;
    return `${path}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/**
 * Opens a URL in a real browser tab from Gera's trusted document and severs the
 * opener. Returns false when the popup blocker refused (no user activation).
 */
export function openInBrowserTab(url: string): boolean {
  try {
    const popup = window.open(url, "_blank");
    if (!popup) return false;
    try {
      popup.opener = null;
    } catch {
      // Cross-origin handles may refuse the write; the window is still open.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends an external popup to a real tab; when the browser blocks it the user
 * gets a toast whose action retries under a genuine click.
 */
export function openPreviewPopupExternally(url: string): void {
  if (openInBrowserTab(url)) return;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw URL as the description
  }
  toast("The preview wants to open a new tab", {
    description: host,
    action: { label: "Open", onClick: () => void openInBrowserTab(url) },
  });
}

/**
 * Maps a `message` event source back to the preview frame that sent it.
 * Frames carry `data-preview-frame="<prefix><key>"`; only frames under the
 * caller's prefix count, so two panels never answer each other's popups.
 */
export function findPreviewFrameKey(prefix: string, source: MessageEventSource | null): string | null {
  if (!source || typeof document === "undefined") return null;
  const frames = document.querySelectorAll<HTMLIFrameElement>("iframe[data-preview-frame]");
  for (const frame of frames) {
    const key = frame.dataset.previewFrame ?? "";
    if (key.startsWith(prefix) && frame.contentWindow === source) {
      return key.slice(prefix.length);
    }
  }
  return null;
}
