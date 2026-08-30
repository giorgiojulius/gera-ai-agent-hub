// Recovery from stale-deploy chunk failures. Every deploy renames the hashed
// JS/CSS chunks in /assets and deletes the old ones, so a tab that loaded the
// previous build gets a 404 the moment it lazy-loads something new (a mermaid
// diagram type, the map library, a CSS preload). Vite reports every such
// failure through the window "vite:preloadError" event — we reload the page
// once to pick up the fresh build, with a guard so a genuinely broken network
// can never cause a reload loop.

const RELOAD_GUARD_KEY = "gera.chunk-reload-at";

/** Minimum gap between automatic reloads — anything sooner surfaces the error. */
export const RELOAD_LOOP_WINDOW_MS = 60_000;

// Chrome / Firefox / Safari phrase dynamic-import failures differently, and
// Vite's own helper adds a fourth shape for CSS preloads.
const STALE_CHUNK_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "unable to preload css",
];

/** True when an error is a chunk-load failure (stale deploy or network drop). */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = message.toLowerCase();
  return STALE_CHUNK_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Pure loop guard: allow a reload only if the last one is old enough. */
export function shouldAutoReload(lastReloadAt: number, now: number): boolean {
  return now - lastReloadAt >= RELOAD_LOOP_WINDOW_MS;
}

let installed = false;

/**
 * Hooks Vite's preload-failure event once per session. On the first failure
 * the page reloads in place (same URL, so the user lands exactly where they
 * were); repeat failures within the window — or failures while offline, where
 * a reload would strand the user on the browser error page — are left to the
 * caller's own error UI.
 */
export function installStaleChunkRecovery(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  window.addEventListener("vite:preloadError", (event) => {
    if (navigator.onLine === false) {
      return;
    }
    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? "0") || 0;
    } catch {
      // Storage blocked — fall through with 0; the offline check above and the
      // fact that a reload fetches fresh HTML keep loops practically impossible.
    }
    if (!shouldAutoReload(lastReloadAt, Date.now())) {
      return;
    }
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      // Ignore — best effort.
    }
    event.preventDefault();
    window.location.reload();
  });
}
