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
} from "@/lib/preview-bridge";

export type PreviewBridgeOptions = {
  /** `data-preview-frame` prefix shared by this surface's frames; the remainder is the frame key. */
  prefix: string;
  /** Artifact root; decides between in-panel pages and real browser windows. */
  previewUrl: string | null;
  /**
   * Receives same-origin popups as new pages. `opener` names the shim-side
   * popup to report as closed when that page goes away (`notifyClosed`).
   * Surfaces without a tab strip omit this and every popup becomes a window.
   */
  onOpenTab?: (frameKey: string, url: string, opener: PopupOpener | null) => void;
  /** Live route/title of a frame, for address bars and tab labels. */
  onState?: (frameKey: string, state: { href: string; title: string }) => void;
};

export type PreviewBridge = {
  /** Reports a popup that lived as a panel tab as closed to the frame that opened it. */
  notifyClosed: (opener: PopupOpener) => void;
};

/**
 * Wires one preview surface to the shim running inside its sandboxed frames:
 * validates bridge messages, maps them to the surface's own frames, routes
 * popups (page tab, proxied real window, or refused) and plays opener for the
 * real windows via `PreviewPopupRegistry`. Options may close over fresh state;
 * the latest render's versions run.
 */
export function usePreviewBridge(options: PreviewBridgeOptions): PreviewBridge {
  const optionsRef = useRef<PreviewBridgeOptions>(options);
  const registryRef = useRef<PreviewPopupRegistry | null>(null);

  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const registry = new PreviewPopupRegistry((frameKey) => findPreviewFrame(optionsRef.current.prefix, frameKey));
    registryRef.current = registry;

    const listener = (event: MessageEvent) => {
      if (registry.relay(event)) return;
      const message = parsePreviewBridgeMessage(event.data);
      if (!message) return;
      const { prefix, previewUrl, onOpenTab, onState } = optionsRef.current;
      const frameKey = findPreviewFrameKey(prefix, event.source);
      if (frameKey === null) return;

      switch (message.type) {
        case "state":
          onState?.(frameKey, { href: message.href, title: message.title });
          return;
        case "close":
          registry.close(frameKey, message.id);
          return;
        case "focus":
          registry.focus(frameKey, message.id);
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
          if (message.id && registry.has(frameKey, message.id)) {
            // The app navigates a window it already holds (blank-then-navigate): keep that same real window.
            if (!registry.open(frameKey, message.id, route.url, message.features)) registry.notifyClosed(frameKey, message.id);
            return;
          }
          if (route.kind === "blank") {
            if (!message.id) {
              openPreviewPopupExternally(route.url);
              return;
            }
            // A blank window the app will navigate shortly: no toast when the blocker refuses — the
            // follow-up navigation gets its own offer — but the stub must learn it never opened.
            if (!registry.open(frameKey, message.id, route.url, message.features)) registry.notifyClosed(frameKey, message.id);
            return;
          }
          if (route.kind === "tab" && onOpenTab) {
            onOpenTab(frameKey, route.url, message.id ? { frameKey, id: message.id } : null);
            return;
          }
          if (!message.id) {
            // A `target="_blank"` link: a plain new tab with the opener severed, like the browser would.
            openPreviewPopupExternally(route.url);
            return;
          }
          const { id, features } = message;
          if (registry.open(frameKey, id, route.url, features)) return;
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
      notifyClosed: (opener) => registryRef.current?.notifyClosed(opener.frameKey, opener.id),
    }),
    [],
  );
}
