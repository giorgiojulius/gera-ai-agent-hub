import { useEffect, useState } from "react";

import { SparkMark } from "@/components/gera/Spark";
import { completeServerOAuthSignIn, oauthResultStorageKey } from "@/lib/mcp-oauth";

/**
 * OAuth completion page. The backend already exchanged and stored the code;
 * this page carries status only and never receives a provider credential.
 */
export default function OAuthCallback() {
  const [message, setMessage] = useState<string>("Completing sign-in…");

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const state = params.get("state") ?? "";
      const challenge = params.get("challenge") ?? "";
      let status = params.get("status") ?? "";
      let error = params.get("error_description") ?? params.get("error") ?? "";
      if (status === "confirm") {
        try {
          await completeServerOAuthSignIn(state, challenge);
          status = "complete";
        } catch (cause) {
          status = "error";
          error = cause instanceof Error ? cause.message : "OAuth confirmation failed.";
        }
      }
      if (cancelled) {
        return;
      }
      const payload = { type: "gera-mcp-oauth", state, status, error };
      try {
        window.localStorage.setItem(oauthResultStorageKey(state), JSON.stringify(payload));
      } catch {
        // storage unavailable; server status polling remains authoritative
      }
      try {
        window.opener?.postMessage(payload, window.location.origin);
      } catch {
        // opener may be gone
      }
      setMessage(
        status === "complete"
          ? "Signed in securely. You can close this window."
          : error || "Sign-in did not complete. You can close this window.",
      );
      timer = window.setTimeout(() => window.close(), 1200);
    })();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <SparkMark className="h-8 w-8" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
