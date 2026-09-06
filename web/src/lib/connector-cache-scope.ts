import { authSessionSnapshot } from "@/lib/auth-tokens";
import { AuthSessionChangedError } from "@/lib/backend";

let account = "";
let epoch = 0;
const generations = new Map<string, number>();
const listeners = new Set<() => void>();
/** Non-secret account/connection identity for cached inventories and repository lists. */
export function connectorCacheKey(serverId: string): string {
  const current = authSessionSnapshot();
  if (account !== current) { account = current; epoch += 1; generations.clear(); }
  return `${current}:${epoch}:${serverId}:${generations.get(serverId) ?? 0}`;
}
/** Supersedes cached and pending work on Re-check, unlink, credential change, or account exit. */
export function invalidateConnectorCaches(serverId?: string): void {
  if (serverId) generations.set(serverId, (generations.get(serverId) ?? 0) + 1);
  else { epoch += 1; generations.clear(); }
  for (const listener of listeners) listener();
}
/** Guards response-body parsing and subsequent pages, not just the first request. */
export function assertConnectorScope(serverId: string, expected: string): void {
  if (connectorCacheKey(serverId) !== expected) throw new AuthSessionChangedError();
}
/** Allows mounted menus to discard component-local copies after connector invalidation. */
export function subscribeConnectorCaches(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
