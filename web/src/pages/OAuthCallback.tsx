import { useEffect, useState } from "react";

import { SparkMark } from "@/components/gera/Spark";
import { OAUTH_RESULT_KEY } from "@/lib/mcp-oauth";

/**
 * OAuth redirect target for MCP sign-in popups. Hands the authorization code
 * back to the opener via postMessage and localStorage, then closes itself.
 */
export default function OAuthCallback() {
  const [message, setMessage] = useState<string>("Completing sign-in…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payload = {
      type: "gera-mcp-oauth",
      state: params.get("state") ?? "",
      code: params.get("code") ?? "",
      error: params.get("error_description") ?? params.get("error") ?? "",
      iss: params.get("iss") ?? "",
    };
    try {
      window.localStorage.setItem(OAUTH_RESULT_KEY, JSON.stringify(payload));
    } catch {
      // storage unavailable; postMessage below still covers same-window openers
    }
    try {
      window.opener?.postMessage(payload, window.location.origin);
    } catch {
      // opener may be gone
    }
    setMessage(
      payload.code
        ? "Signed in. You can close this window."
        : payload.error || "Sign-in did not complete. You can close this window.",
    );
    const timer = window.setTimeout(() => {
      window.close();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <SparkMark className="h-8 w-8" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
