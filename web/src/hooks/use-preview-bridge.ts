import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import {
  PreviewPopupRegistry,
  findPreviewFrame,
  findPreviewFrameKey,
  offerBlockedPopup,
  openPreviewPopupExternally,
  parsePreviewBridgeMessage,
  routePreviewPopup,
  type PopupOpener,
  type PopupPage,
} from "@/lib/preview-bridge";

/**
 * A surface with a tab strip: every popup the preview opens lives there as a
 * tab — an in-preview page, an empty page, or the stand-in for a real browser
 * window — so the user always sees where a `window.open` went.
 */
export type PreviewTabHost = {
  /**
   * Shows a popup as a tab. With an `opener` that already has a tab (the app
   * navigates a window it holds: blank-then-navigate, redirects) the existing
   * tab is retargeted instead of a second one appearing.
   */
  open: (frameKey: string, page: PopupPage, opener: PopupOpener | null) => void;
  /** `popup.close()` from the preview. */
  close: (opener: PopupOpener) => void;
  /** `popup.focus()` from the preview. */
  focus: (opener: PopupOpener) => void;
  /** The popup is gone for good (real window closed by the user, refused, or dismissed). */
  closed: (opener: PopupOpener) => void;
};

export type PreviewBridgeOptions = {
  /** `data-preview-frame` prefix shared by this surface's frames; the remainder is the frame key. */
  prefix: string;
  /** Artifact root; decides between in-panel pages and real browser windows. */
  previewUrl: string | null;
  /** Tab strip receiving popups as tabs. Surfaces without one omit this and every popup becomes a window. */
  tabs?: PreviewTabHost;
  /** Live route/title of a frame, for address bars and tab labels. */
  onState?: (frameKey: string, state: { href: string; title: string }) => void;
};

export type PreviewBridge = {
  /** The surface dropped a popup's tab: closes any real window behind it and reports `closed` to the opener frame. */
  dismissPopup: (opener: PopupOpener) => void;
  /** Retries the real window behind a `window` tab under a genuine user click. */
  openPopupWindow: (opener: PopupOpener, url: string, features: string) => boolean;
  /** Brings the real window behind a `window` tab to the front. */
  focusPopupWindow: (opener: PopupOpener) => void;
};

/**
 * Wires one preview surface to the shim running inside its sandboxed frames:
 * validates bridge messages, maps them to the surface's own frames, routes
 * popups (tab, proxied real window, or refused) and plays opener for the real
 * windows via `PreviewPopupRegistry`. Options may close over fresh state; the
 * latest render's versions run.
 */
export function usePreviewBridge(options: PreviewBridgeOptions): PreviewBridge {
  const optionsRef = useRef<PreviewBridgeOptions>(options);
  const registryRef = useRef<PreviewPopupRegistry | null>(null);

  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const registry = new PreviewPopupRegistry((frameKey) => findPreviewFrame(optionsRef.current.prefix, frameKey));
    registry.onClosed = (frameKey, id) => optionsRef.current.tabs?.closed({ frameKey, id });
    registryRef.current = registry;

    const listener = (event: MessageEvent) => {
      if (registry.relay(event)) return;
      const message = parsePreviewBridgeMessage(event.data);
      if (!message) return;
      const { prefix, previewUrl, tabs, onState } = optionsRef.current;
      const frameKey = findPreviewFrameKey(prefix, event.source);
      if (frameKey === null) return;

      switch (message.type) {
        case "state":
          onState?.(frameKey, { href: message.href, title: message.title });
          return;
        case "close":
          registry.close(frameKey, message.id);
          tabs?.close({ frameKey, id: message.id });
          return;
        case "focus":
          registry.focus(frameKey, message.id);
          tabs?.focus({ frameKey, id: message.id });
          return;
        case "message":
          registry.send(frameKey, message.id, message.data, message.targetOrigin);
          return;
        case "open": {
          if (!previewUrl) return;
          const route = routePreviewPopup(message.url, previewUrl);
          if (route.kind === "blocked") {
            console.warn("[repo-preview] refused popup from preview", route.reason);
            if (message.id) registry.notifyClosed(frameKey, message.id);
            return;
          }
          if (!message.id) {
            // A link (`target="_blank"`, ⌘-click): in-preview pages join the tab strip; anything else is a
            // plain browser tab with the opener severed, like the browser would do.
            if (route.kind === "tab" && tabs) tabs.open(frameKey, { kind: "page", url: route.url }, null);
            else openPreviewPopupExternally(route.url);
            return;
          }
          const { id, features } = message;
          const opener: PopupOpener = { frameKey, id };
          if (registry.has(frameKey, id)) {
            // The app steers a real window it already holds (blank-then-navigate, redirects): same window, never a second one.
            if (!registry.open(frameKey, id, route.url, features)) {
              registry.notifyClosed(frameKey, id);
              return;
            }
            tabs?.open(frameKey, { kind: "window", url: route.url, features, opened: true }, opener);
            return;
          }
          if (tabs) {
            if (route.kind === "tab") {
              tabs.open(frameKey, { kind: "page", url: route.url }, opener);
              return;
            }
            if (route.kind === "blank") {
              tabs.open(frameKey, { kind: "blank" }, opener);
              return;
            }
            // Other origins cannot run inside the panel (framing refusals, OAuth callbacks needing a real
            // `opener`): the window opens for real and a tab stands in for it — with a retry when blocked.
            const opened = registry.open(frameKey, id, route.url, features);
            tabs.open(frameKey, { kind: "window", url: route.url, features, opened }, opener);
            return;
          }
          if (registry.open(frameKey, id, route.url, features)) return;
          if (route.kind === "blank") {
            // A blank window the app will navigate shortly: the follow-up navigation gets its own offer,
            // but the stub must learn this one never opened.
            registry.notifyClosed(frameKey, id);
            return;
          }
          offerBlockedPopup(
            route.url,
            () => registry.open(frameKey, id, route.url, features),
            () => registry.notifyClosed(frameKey, id),
          );
          return;
        }
      }
    };

    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
      registry.dispose();
      registryRef.current = null;
    };
  }, []);

  return useMemo<PreviewBridge>(
    () => ({
      dismissPopup: (opener) => {
        registryRef.current?.close(opener.frameKey, opener.id);
        registryRef.current?.notifyClosed(opener.frameKey, opener.id);
      },
      openPopupWindow: (opener, url, features) => registryRef.current?.open(opener.frameKey, opener.id, url, features) ?? false,
      focusPopupWindow: (opener) => registryRef.current?.focus(opener.frameKey, opener.id),
    }),
    [],
  );
}
