import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSessionSnapshot, invalidateAuthSession } from "@/lib/auth-tokens";
import { fetchMcpInventory, clearMcpInventoryCache } from "@/lib/mcp-inventory";
import { githubAccountReference, githubTransportFetch } from "@/lib/github-transport";
import { invalidateConnectorCaches } from "@/lib/connector-cache-scope";
import { handleProjectGitHubValidate } from "../../../functions/project-github-credentials";
import { relayGitHubAccount, type GitHubAccountRelayContext } from "../../../functions/github-account-relay";

beforeEach(() => { invalidateAuthSession(); clearMcpInventoryCache(); });
afterEach(() => vi.unstubAllGlobals());
const inventory = (name: string): Response => Response.json({ prompts: [{ name }], resources: [], resourceTemplates: [], toolCount: 1, cached: false });

describe("server-only browser connector boundaries", () => {
  it("rejects raw provider Authorization before making a browser request", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    await expect(githubTransportFetch("Bearer ghp-private", new URL("https://api.github.com/user"), {})).rejects.toThrow(/Save and check/);
    expect(network).not.toHaveBeenCalled();
  });
  it("an issued reference cannot cross an account or connection change", async () => {
    const network = vi.fn(async () => Response.json({ login: "x" })); vi.stubGlobal("fetch", network);
    const reference = githubAccountReference("github");
    invalidateConnectorCaches("github");
    await expect(githubTransportFetch(reference, new URL("https://api.github.com/user"), {})).rejects.toThrow(/account changed/);
    const other = githubAccountReference("github");
    invalidateAuthSession();
    await expect(githubTransportFetch(other, new URL("https://api.github.com/user"), {})).rejects.toThrow(/account changed/);
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["recheck", "account"])("%s prevents late inventory results from repopulating or deleting newer in-flight work", async (kind) => {
    authSessionSnapshot();
    const replies: Array<(response: Response) => void> = [];
    const network = vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve)));
    vi.stubGlobal("fetch", network);
    const stale = fetchMcpInventory("srv").catch((error: unknown) => error);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    if (kind === "account") invalidateAuthSession(); else clearMcpInventoryCache("srv");
    const current = fetchMcpInventory("srv");
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[0](inventory("old"));
    expect(await stale).toBeInstanceOf(Error);
    expect(fetchMcpInventory("srv")).toBe(current);
    replies[1](inventory("new"));
    expect((await current).prompts[0].name).toBe("new");
    expect((await fetchMcpInventory("srv")).prompts[0].name).toBe("new");
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("project PAT validation checks admin access before contacting the provider and returns no token", async () => {
    const network = vi.fn(async () => Response.json({ login: "project-user", name: "Project" })); vi.stubGlobal("fetch", network);
    const denied = await handleProjectGitHubValidate({ token: "project-pat" }, false);
    expect(denied.status).toBe(403); expect(network).not.toHaveBeenCalled();
    const accepted = await handleProjectGitHubValidate({ token: "project-pat" }, true);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).not.toContain("project-pat");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("GitHub proxy preserves step-up and temporary lease failures without exposing internal credentials", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const ctx: GitHubAccountRelayContext<string> = {
      corsHeaders: {}, corsJson: (body, status) => Response.json(body, { status }), requireAccount: async () => "owner",
      readBoundedText: async () => "", shardCall: async () => Response.json({ error: "step_up_required", authorization: "must-not-return" }, { status: 403 }),
    };
    const url = new URL("https://gera.test/github-proxy?serverId=github&path=%2Fuser");
    const denied = await relayGitHubAccount(ctx, new Request(url), url);
    expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ error: "step_up_required" });
    ctx.shardCall = async () => Response.json({ error: "retryable_error" }, { status: 503 });
    const retryable = await relayGitHubAccount(ctx, new Request(url), url);
    expect(retryable.status).toBe(503); expect(network).not.toHaveBeenCalled();
  });
});
