import { describe, expect, it } from "vitest";

import { vaultStatusLabel } from "@/components/gera/VaultStatusLine";
import { summarizeVault, type VaultStatus } from "@/lib/diagnostics";

const tally = (total: number, sealed: number, current: number) => ({
  total,
  sealed,
  current,
  plaintext: total - sealed,
});

describe("vault status line", () => {
  it("sums the per-table tallies", () => {
    const status: VaultStatus = {
      vault: "enabled",
      swept: true,
      rows: { grants: tally(4, 4, 4), serverSecrets: tally(2, 2, 1), pending: tally(0, 0, 0) },
    };
    expect(summarizeVault(status)).toEqual({ total: 6, sealed: 6, current: 5, plaintext: 0 });
  });

  it("reads calm when everything is sealed under the current key", () => {
    const label = vaultStatusLabel({ vault: "enabled", swept: true, rows: { grants: tally(3, 3, 3) } });
    expect(label).toEqual({ text: "Credential vault · key active · 3/3 sealed · swept under current key", warn: false });
  });

  it("warns on plaintext rows, a pending sweep, rows under a previous key, or a missing server key", () => {
    expect(vaultStatusLabel({ vault: "enabled", swept: true, rows: { grants: tally(3, 2, 2) } })).toEqual({
      text: "Credential vault · key active · 2/3 sealed · 1 plaintext · swept under current key",
      warn: true,
    });
    expect(vaultStatusLabel({ vault: "enabled", swept: false, rows: { grants: tally(2, 2, 1) } })).toEqual({
      text: "Credential vault · key active · 2/2 sealed · 1 under a previous key · sweep pending",
      warn: true,
    });
    expect(vaultStatusLabel({ vault: "secrets_key_malformed", swept: false, rows: {} })).toEqual({
      text: "Credential vault · server key unavailable (secrets_key_malformed)",
      warn: true,
    });
  });

  it("says so when the account simply has nothing stored yet", () => {
    expect(vaultStatusLabel({ vault: "enabled", swept: true, rows: { grants: tally(0, 0, 0) } })).toEqual({
      text: "Credential vault · key active · no stored credentials",
      warn: false,
    });
  });

  it("names the scope binding and asks to reconnect servers the account-scope sweep could not open", () => {
    expect(vaultStatusLabel({ vault: "enabled", swept: true, rows: { grants: tally(3, 3, 3) }, scope: "account" })).toEqual({
      text: "Credential vault · key active · 3/3 sealed · swept under current key · bound to account",
      warn: false,
    });
    expect(vaultStatusLabel({ vault: "enabled", swept: true, rows: { grants: tally(3, 3, 3) }, scope: "owner" })).toEqual({
      text: "Credential vault · key active · 3/3 sealed · swept under current key · bound to owner (account binding pending)",
      warn: false,
    });
    expect(vaultStatusLabel({ vault: "enabled", swept: true, rows: { grants: tally(4, 4, 4) }, scope: "account", unreadable: 2 })).toEqual({
      text: "Credential vault · key active · 4/4 sealed · swept under current key · bound to account · 2 unreadable — reconnect those servers",
      warn: true,
    });
  });
});
