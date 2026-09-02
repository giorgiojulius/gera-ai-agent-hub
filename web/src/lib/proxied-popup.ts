/**
 * Real browser windows Gera opens on behalf of a sandboxed preview, and the
 * way an OAuth callback page inside one finds its way back.
 *
 * A Repo Preview runs in an opaque-origin sandbox, so its `window.open` is
 * proxied: Gera opens the real window from its own document and plays opener
 * (`PreviewPopupRegistry`). Rork Auth's `preview` flow ends on a page that
 * posts the code to `window.opener` for the Rork preview origin only — which
 * the opener here is not, whatever origin Gera runs on — so sandboxed builds
 * ask for the `production` flow instead. That lands the window on Gera's own
 * `/auth/callback`, and this module is how that page hands the authorization
 * code back to the preview frame, which holds the PKCE verifier:
 *
 * - the window carries a name only Gera's trusted document mints, so the page
 *   knows it stands in for a preview popup and may close itself afterwards;
 * - the code is posted only to Gera's own origins (this deployment and the
 *   project's Rork preview), never `"*"`: a hostile page that opened the same
 *   window for a flow it initiated must not be handed a victim's code.
 */

export const PROXIED_POPUP_NAME_PREFIX = "gera-preview-popup-";

const PROXIED_POPUP_NAME = /^gera-preview-popup-[a-z0-9]{6,32}$/;

const PROJECT_ID = /^[a-z0-9]{6,64}$/i;

/** A fresh window name for a real window Gera opens for a preview popup. */
export function proxiedPopupName(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${PROXIED_POPUP_NAME_PREFIX}${suffix}`;
}

/** True when `window.name` says Gera opened this window for a sandboxed preview. */
export function isProxiedPopupName(name: unknown): boolean {
  return typeof name === "string" && PROXIED_POPUP_NAME.test(name);
}

/**
 * Gera origins an authorization code may be handed to: the deployment serving
 * the callback page, plus the project's Rork web preview. Anything that is not
 * a web origin (an opaque `"null"`, an empty string) is left out.
 */
export function trustedRelayOrigins(pageOrigin: string, projectId: string | null | undefined): string[] {
  const origins = new Set<string>();
  if (/^https?:\/\/[^/\s]+$/.test(pageOrigin)) {
    origins.add(pageOrigin);
  }
  const id = (projectId ?? "").trim();
  if (PROJECT_ID.test(id)) {
    origins.add(`https://${id}-web.rork.live`);
  }
  return [...origins];
}

export type RorkAuthCallbackPayload = {
  type: "rork_auth_callback";
  code?: string;
  error?: string;
};

/**
 * What the `/auth/callback` URL brought: an authorization code, or the
 * provider's refusal (`error_description` over `error`), capped and trimmed.
 * A landing with neither reports `no_code` so the opener stops waiting.
 */
export function rorkAuthCallbackPayload(search: string): RorkAuthCallbackPayload {
  const params = new URLSearchParams(search);
  const code = params.get("code")?.trim() ?? "";
  if (code) {
    return { type: "rork_auth_callback", code };
  }
  const error = (params.get("error_description") ?? params.get("error") ?? "").trim().slice(0, 200);
  return { type: "rork_auth_callback", error: error || "no_code" };
}

/** The slice of `window.opener` the relay touches. */
export type OpenerLike = { postMessage: (message: unknown, targetOrigin: string) => void };

/**
 * Hands the callback payload to the opener, once per trusted origin — the
 * browser delivers only to the origin the opener actually has and drops the
 * rest. Returns how many posts went out (0 without an opener or origins).
 */
export function relayAuthCallbackToOpener(
  opener: OpenerLike | null | undefined,
  payload: RorkAuthCallbackPayload,
  origins: readonly string[],
): number {
  if (!opener || typeof opener.postMessage !== "function") {
    return 0;
  }
  let posted = 0;
  for (const origin of origins) {
    try {
      opener.postMessage(payload, origin);
      posted += 1;
    } catch {
      // A closed opener or an origin the browser rejects; nothing to deliver there.
    }
  }
  return posted;
}
