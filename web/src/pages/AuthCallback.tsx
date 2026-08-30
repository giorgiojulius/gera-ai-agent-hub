import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { SparkMark } from "@/components/gera/Spark";
import { useAuth } from "@/hooks/use-auth";

/**
 * Production OAuth landing: Rork redirects back to /auth/callback?code=…
 * after Google/Apple sign-in. The preview popup flow never hits this route.
 */
export default function AuthCallback() {
  const { exchangeCode } = useAuth();
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) {
      return;
    }
    ran.current = true;
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) {
      navigate("/", { replace: true });
      return;
    }
    void exchangeCode(code).finally(() => navigate("/", { replace: true }));
  }, [exchangeCode, navigate]);

  return (
    <div className="relative flex h-svh items-center justify-center overflow-hidden">
      <div className="gera-atmosphere pointer-events-none absolute inset-0" />
      <div className="relative z-10 flex flex-col items-center gap-3">
        <SparkMark className="h-10 w-10 animate-pulse" />
        <p className="text-sm text-muted-foreground">Signing you in…</p>
      </div>
    </div>
  );
}
