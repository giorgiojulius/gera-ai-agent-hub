import { useQuery } from "@tanstack/react-query";
import { LockKeyhole, ShieldAlert } from "lucide-react";

import { fetchVaultStatus, summarizeVault, type VaultStatus } from "@/lib/diagnostics";
import { cn } from "@/lib/utils";

/** One-line copy for the vault status; exported for the unit test. */
export function vaultStatusLabel(status: VaultStatus): { text: string; warn: boolean } {
  const sum = summarizeVault(status);
  if (status.vault !== "enabled") {
    return { text: `Credential vault · server key unavailable (${status.vault})`, warn: true };
  }
  if (sum.total === 0) {
    return { text: `Credential vault · key active · no stored credentials${status.swept ? "" : " · sweep pending"}`, warn: false };
  }
  const plain = sum.plaintext > 0 ? ` · ${sum.plaintext} plaintext` : "";
  const stale = sum.sealed - sum.current > 0 ? ` · ${sum.sealed - sum.current} under a previous key` : "";
  const sweep = status.swept ? "swept under current key" : "sweep pending";
  const scope = status.scope === "account" ? " · bound to account" : status.scope === "owner" ? " · bound to owner (account binding pending)" : "";
  const unreadable = (status.unreadable ?? 0) > 0 ? ` · ${status.unreadable} unreadable — reconnect those servers` : "";
  return {
    text: `Credential vault · key active · ${sum.sealed}/${sum.total} sealed${plain}${stale} · ${sweep}${scope}${unreadable}`,
    warn: sum.plaintext > 0 || !status.swept || (status.unreadable ?? 0) > 0,
  };
}

/**
 * The account's self-check that its stored credentials are encrypted: server
 * key active, rows sealed, storage swept under the current key. Counts only —
 * the backend never returns a value, the key, or its id.
 */
export function VaultStatusLine({ className }: { className?: string }) {
  const query = useQuery({
    queryKey: ["diag", "vault"],
    queryFn: () => fetchVaultStatus(),
    staleTime: 30_000,
    retry: false,
  });

  let text = "Credential vault · checking…";
  let warn = false;
  if (query.isError) {
    text = "Credential vault · status unavailable";
  } else if (query.data) {
    ({ text, warn } = vaultStatusLabel(query.data));
  }
  const Icon = warn ? ShieldAlert : LockKeyhole;

  return (
    <div
      data-testid="vault-status"
      className={cn(
        "flex items-center gap-1.5 text-[11px]",
        warn ? "text-ember" : "text-muted-foreground",
        className,
      )}
      title="Encryption at rest for OAuth grants, pasted keys and bot tokens stored on the server"
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}
