import { useEffect, useLayoutEffect, useRef } from "react";

import { parsePreviewBridgeMessage, type PreviewBridgeMessage } from "@/lib/preview-bridge";

/**
 * Listens for bridge messages posted by sandboxed preview frames. `resolveFrame`
 * turns the event source into the caller's own frame key (or null to ignore the
 * message); `onMessage` receives validated payloads for matched frames only.
 * Both callbacks may close over fresh state — the latest render's versions run.
 */
export function usePreviewBridge(
  resolveFrame: (source: MessageEventSource | null) => string | null,
  onMessage: (frameKey: string, message: PreviewBridgeMessage) => void,
): void {
  const resolveRef = useRef<typeof resolveFrame>(resolveFrame);
  const handlerRef = useRef<typeof onMessage>(onMessage);

  useLayoutEffect(() => {
    resolveRef.current = resolveFrame;
    handlerRef.current = onMessage;
  });

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = parsePreviewBridgeMessage(event.data);
      if (!message) return;
      const key = resolveRef.current(event.source);
      if (key === null) return;
      handlerRef.current(key, message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
}
