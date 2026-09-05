import { KeyRound } from "lucide-react";

import {
  describeMcpCredentialMigration,
  loadMcpCredentialMigrationReport,
} from "@/lib/mcp-credential-migration";
import { cn } from "@/lib/utils";

/**
 * One line in Diagnostics after the one-time move of MCP sign-ins out of the
 * browser: how many the vault already held and how many still need a fresh
 * sign-in. Counts only — never ids of tokens or their values. Renders nothing
 * when this browser never held a legacy grant.
 */
export function CredentialMigrationLine({ className }: { className?: string }) {
  const text = describeMcpCredentialMigration(loadMcpCredentialMigrationReport());
  if (!text) {
    return null;
  }
  return (
    <div
      data-testid="credential-migration"
      className={cn("flex items-center gap-1.5 text-[11px] text-muted-foreground", className)}
      title="Older versions kept MCP sign-ins in this browser; they were removed and the account vault is now their only home"
    >
      <KeyRound className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}
