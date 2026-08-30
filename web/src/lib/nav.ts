/**
 * Navigation bridge + canonical object addresses.
 *
 * React Router's `navigate` only exists inside the router tree, but places
 * like toast actions in the AgentProvider (which wraps the router) still need
 * to send the user somewhere. `<NavBridge />` registers the live navigate
 * function here; `appNavigate` is a safe no-op until the router mounts.
 */

let navigateFn: ((to: string) => void) | null = null;

/** Called by the bridge component inside the router; returns a cleanup. */
export function registerNavigate(fn: (to: string) => void): () => void {
  navigateFn = fn;
  return () => {
    if (navigateFn === fn) {
      navigateFn = null;
    }
  };
}

/** Navigate from outside the router tree (toasts, notifications). */
export function appNavigate(to: string): void {
  navigateFn?.(to);
}

/** Canonical address of one chat thread. */
export function chatPath(id: string): string {
  return `/c/${encodeURIComponent(id)}`;
}
