import { toast } from "sonner";

/** `source` stamp of every message the served preview's shim posts to its embedder. */
export const PREVIEW_BRIDGE_SOURCE = "gera-preview";

/** `source` stamp of every message Gera posts back into a preview frame. */
export const PREVIEW_HOST_SOURCE = "gera-preview-host";

/** Upper bound on browser-style tabs one docked preview may keep mounted. */
export const MAX_PREVIEW_TABS = 8;

/** Popup ids minted by the shim: short, opaque, safe to echo back. */
const POPUP_ID = /^[a-z0-9_-]{1,32}$/i;

export type PreviewBridgeMessage =
  | { type: "open"; url: string; target: string; id: string | null; features: string }
  | { type: "close"; id: string }
  | { type: "focus"; id: string }
  | { type: "message"; id: string; data: unknown; targetOrigin: string }
  | { type: "state"; href: string; title: string };

export type PreviewHostMessage =
  | { source: typeof PREVIEW_HOST_SOURCE; type: "closed"; id: string }
  | { source: typeof PREVIEW_HOST_SOURCE; type: "message"; id: string; origin: string; data: unknown };

/** Names the frame and shim-side popup id a real window (or panel tab) stands in for. */
export type PopupOpener = { frameKey: string; id: string };

/** Where a popup requested by the sandboxed preview should go. */
export type PopupRoute =
  | { kind: "tab"; url: string }
  | { kind: "external"; url: string }
  | { kind: "blocked"; reason: "invalid-url" | "scheme" | "credentials" };

function popupId(value: unknown): string | null {
  return typeof value === "string" && POPUP_ID.test(value) ? value : null;
}

/**
 * Validates a cross-document message from an opaque-origin preview frame.
 * Only the documented shapes with string payloads pass; everything else is
 * treated as noise so a hostile build cannot smuggle richer structures in.
 * (`message.data` is opaque by design: it is only ever forwarded to the popup
 * the same frame opened, never interpreted by Gera.)
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
      id: popupId(record.id),
      features: sanitizePopupFeatures(typeof record.features === "string" ? record.features : ""),
    };
  }
  if (record.type === "state" && typeof record.href === "string") {
    return {
      type: "state",
      href: record.href.slice(0, 4_096),
      title: typeof record.title === "string" ? record.title.trim().slice(0, 200) : "",
    };
  }
  const id = popupId(record.id);
  if (!id) return null;
  if (record.type === "close") return { type: "close", id };
  if (record.type === "focus") return { type: "focus", id };
  if (record.type === "message") {
    return {
      type: "message",
      id,
      data: record.data,
      targetOrigin: typeof record.targetOrigin === "string" ? record.targetOrigin.slice(0, 512) : "*",
    };
  }
  return null;
}

/**
 * Keeps the window-placement hints an app passed to `window.open`
 * (`popup,width=560,height=720`, …) and drops the tokens that would make the
 * browser hand back `null` (`noopener`, `noreferrer`): the proxy needs the
 * handle to relay `closed` and callback messages.
 */
export function sanitizePopupFeatures(features: string): string {
  return features
    .slice(0, 256)
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !/^(noopener|noreferrer)\b/i.test(token))
    .join(",");
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
 * as real browser windows, and non-web schemes or embedded credentials are refused.
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
 * opener (what a `target="_blank"` link does in a modern browser). Returns
 * false when the popup blocker refused (no user activation).
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

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Sends an external link click to a real tab; when the browser blocks it the
 * user gets a toast whose action retries under a genuine click.
 */
export function openPreviewPopupExternally(url: string): void {
  if (openInBrowserTab(url)) return;
  toast("The preview wants to open a new tab", {
    description: hostLabel(url),
    action: { label: "Open", onClick: () => void openInBrowserTab(url) },
  });
}

/**
 * Popup-blocker fallback for a proxied `window.open`: retry under a real click,
 * or — if the toast is dismissed or times out — tell the preview the window is
 * gone so its "waiting for the popup" state can settle instead of spinning.
 */
export function offerBlockedPopup(url: string, retry: () => boolean, giveUp: () => void): void {
  let settled = false;
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };
  toast("The preview wants to open a window", {
    description: hostLabel(url),
    duration: 20_000,
    action: {
      label: "Open",
      onClick: () =>
        finish(() => {
          if (!retry()) giveUp();
        }),
    },
    onDismiss: () => finish(giveUp),
    onAutoClose: () => finish(giveUp),
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

/** The mounted frame behind `<prefix><key>`, if any. */
export function findPreviewFrame(prefix: string, frameKey: string): HTMLIFrameElement | null {
  if (typeof document === "undefined") return null;
  const frames = document.querySelectorAll<HTMLIFrameElement>("iframe[data-preview-frame]");
  for (const frame of frames) {
    if ((frame.dataset.previewFrame ?? "") === `${prefix}${frameKey}`) return frame;
  }
  return null;
}

type PopupEntry = { frameKey: string; id: string; win: Window };

/**
 * Real browser windows standing in for `window.open` calls made inside a
 * sandboxed preview. An opaque-origin frame can only ever open an inert
 * `about:blank`, so the shim hands the call to Gera, which opens the window
 * from its own document and then plays opener for it:
 *
 * - the window keeps `opener` (Gera) so OAuth callback pages can
 *   `opener.postMessage(...)`; whatever they post is relayed into the frame
 *   that asked for the window, and nowhere else;
 * - `closed` is polled and reported back so "waiting for the popup" spinners
 *   settle when the user dismisses the window;
 * - `close()`, `focus()` and `postMessage()` on the shim's stub drive the
 *   real window.
 *
 * Gera never interprets the relayed payloads; they are the same bytes the two
 * pages would have exchanged directly in an unsandboxed browser.
 */
export class PreviewPopupRegistry {
  private readonly entries = new Map<string, PopupEntry>();
  private timer: number | null = null;

  constructor(
    private readonly frameFor: (frameKey: string) => HTMLIFrameElement | null,
    private readonly pollMs: number = 500,
  ) {}

  private static key(frameKey: string, id: string): string {
    return `${frameKey}\u0000${id}`;
  }

  /** Number of live windows currently proxied. */
  get size(): number {
    return this.entries.size;
  }

  /** Opens the real window behind a preview popup, or navigates it when it already exists. */
  open(frameKey: string, id: string, url: string, features: string): boolean {
    const key = PreviewPopupRegistry.key(frameKey, id);
    const existing = this.entries.get(key);
    if (existing && !existing.win.closed) {
      try {
        existing.win.location.href = url;
        existing.win.focus();
        return true;
      } catch {
        // Fall through and open a fresh window.
      }
    }
    let win: Window | null = null;
    try {
      win = window.open(url, "_blank", features);
    } catch {
      win = null;
    }
    if (!win) return false;
    this.entries.set(key, { frameKey, id, win });
    this.ensureLoop();
    return true;
  }

  close(frameKey: string, id: string): void {
    const entry = this.entries.get(PreviewPopupRegistry.key(frameKey, id));
    if (!entry) return;
    try {
      entry.win.close();
    } catch {
      // Cross-origin windows may refuse; the poll picks up whatever state results.
    }
  }

  focus(frameKey: string, id: string): void {
    const entry = this.entries.get(PreviewPopupRegistry.key(frameKey, id));
    if (!entry) return;
    try {
      entry.win.focus();
    } catch {
      // ignore
    }
  }

  /** Forwards a `popup.postMessage(data, targetOrigin)` from the preview to the real window. */
  send(frameKey: string, id: string, data: unknown, targetOrigin: string): void {
    const entry = this.entries.get(PreviewPopupRegistry.key(frameKey, id));
    if (!entry) return;
    try {
      entry.win.postMessage(data, targetOrigin || "*");
    } catch {
      // Invalid target origin or a closed window; nothing to deliver.
    }
  }

  /** Tells the frame one of its popups is gone (window closed, tab closed, popup refused). */
  notifyClosed(frameKey: string, id: string): void {
    this.entries.delete(PreviewPopupRegistry.key(frameKey, id));
    this.postToFrame(frameKey, { source: PREVIEW_HOST_SOURCE, type: "closed", id });
    if (this.entries.size === 0) this.stopLoop();
  }

  /**
   * Relays a message a proxied window posted to Gera into the frame that
   * opened it. Returns true when the event belonged to a proxied window, so
   * callers stop treating it as anything else.
   */
  relay(event: MessageEvent): boolean {
    if (!event.source) return false;
    for (const entry of this.entries.values()) {
      if (entry.win !== event.source) continue;
      this.postToFrame(entry.frameKey, {
        source: PREVIEW_HOST_SOURCE,
        type: "message",
        id: entry.id,
        origin: event.origin,
        data: event.data,
      });
      return true;
    }
    return false;
  }

  /** Drops tracking without closing anything the user may still be using. */
  dispose(): void {
    this.stopLoop();
    this.entries.clear();
  }

  private postToFrame(frameKey: string, message: PreviewHostMessage): void {
    const target = this.frameFor(frameKey)?.contentWindow;
    if (!target) return;
    try {
      target.postMessage(message, "*");
    } catch {
      // The frame may be mid-navigation; the next report catches up.
    }
  }

  private ensureLoop(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), this.pollMs);
  }

  private stopLoop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    for (const entry of Array.from(this.entries.values())) {
      let closed = true;
      try {
        closed = entry.win.closed;
      } catch {
        closed = true;
      }
      if (closed) this.notifyClosed(entry.frameKey, entry.id);
    }
  }
}
