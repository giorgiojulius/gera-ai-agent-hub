import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { SparkMark } from "@/components/gera/Spark";
import { useAuth } from "@/hooks/use-auth";
import { CODE_VERIFIER_KEY } from "@/lib/auth-tokens";
import { TID } from "@/lib/testids";
import {
  isProxiedPopupName,
  relayAuthCallbackToOpener,
  rorkAuthCallbackPayload,
  trustedRelayOrigins,
  type OpenerLike,
} from "@/lib/proxied-popup";

/** How long the relayed popup stays readable before it closes itself. */
const PROXIED_POPUP_CLOSE_DELAY_MS = 600;

function hasLocalVerifier(): boolean {
  try {
    return Boolean(sessionStorage.getItem(CODE_VERIFIER_KEY));
  } catch {
    return false;
  }
}

/**
 * Rork Auth's production landing: `/auth/callback?code=…` after Google/Apple.
 *
 * Top level (the app redirected here itself) the code is exchanged with the
 * verifier this tab saved. Inside a window Gera opened for a sandboxed preview
 * (`window.name` minted by Gera, opener present) the verifier lives in the
 * preview frame instead, so the code is handed to the opener — Gera's own
 * origins only — and the window closes; Gera relays it into the frame, which
 * completes the exchange. A window with an opener but no verifier of its own
 * (an older Gera still opening plain `_blank` windows, a browser that dropped
 * the name) cannot finish the exchange itself either: it gets the same relay
 * and asks to be closed instead of failing with "session expired".
 */
export default function AuthCallback() {
  const { exchangeCode } = useAuth();
  const navigate = useNavigate();
  const { search } = useLocation();
  const ran = useRef(false);
  const [relayed, setRelayed] = useState<boolean>(false);

  useEffect(() => {
    if (ran.current) {
      return;
    }
    ran.current = true;
    const payload = rorkAuthCallbackPayload(search);
    const opener = (window.opener ?? null) as OpenerLike | null;
    const proxied = isProxiedPopupName(window.name);
    if (opener && (proxied || !hasLocalVerifier())) {
      relayAuthCallbackToOpener(
        opener,
        payload,
        trustedRelayOrigins(window.location.origin, import.meta.env.EXPO_PUBLIC_PROJECT_ID),
      );
      setRelayed(true);
      if (proxied) {
        window.setTimeout(() => window.close(), PROXIED_POPUP_CLOSE_DELAY_MS);
      }
      return;
    }
    if (!payload.code) {
      navigate("/", { replace: true });
      return;
    }
    void exchangeCode(payload.code).finally(() => navigate("/", { replace: true }));
  }, [exchangeCode, navigate, search]);

  return (
    <div className="relative flex h-svh items-center justify-center overflow-hidden">
      <div className="gera-atmosphere pointer-events-none absolute inset-0" />
      <div className="relative z-10 flex flex-col items-center gap-3">
        <SparkMark className="h-10 w-10 animate-pulse" />
        <p className="text-sm text-muted-foreground" data-testid={TID.authCallbackStatus}>
          {relayed ? "Returning you to Gera… you can close this window." : "Signing you in…"}
        </p>
      </div>
    </div>
  );
}
