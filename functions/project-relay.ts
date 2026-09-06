// Project relays of the Worker — /projects/* (registry + per-project shard
// sub-routes with post-commit effects), inbound Slack events, the Slack app
// install callback and the public page-view ingest. Moved verbatim out of
// index.ts: the Worker lends the DO binding, CORS helpers and its account /
// invite gates through ProjectRelayContext. Bodies stay bounded here; the
// shard (project-store.ts) owns authorisation and secrets.

import { decodeSlackInstallState } from "./native-slack";

type ExecutionCtx = { waitUntil(promise: Promise<unknown>): void };

/** The slice of the Worker's verified account principal these relays touch. */
export type ProjectRelayAccount = { storageOwner: string };

/** What index.ts lends the project relays. */
export type ProjectRelayContext<A extends ProjectRelayAccount = ProjectRelayAccount> = {
  /** Durable Object namespace binding — ProjectStore registry and shards. */
  durable: { fetch(request: Request): Promise<Response> };
  corsHeaders: Record<string, string>;
  corsJson(data: unknown, status: number): Response;
  /** Platform identity + invite gate; a Response means "answer with this". */
  requireInvitedAccount(request: Request): Promise<A | Response>;
  /** Cached invite check for a member added to a project. */
  isInvitedCached(requestUrl: string, email: string): Promise<boolean>;
  /** Short-lived GitHub authorization proof from the account shard (agent MCP link). */
  accountAuthorizationLease(requestUrl: string, account: A, serverId: string, force: boolean): Promise<string | null>;
};

/** Project route bodies: messages are 8k chars; agent configs stay small. */
const PROJECT_BODY_LIMIT = 300_000;

/** Allow-listed project shard sub-routes and their methods. */
const PROJECT_SUB_ROUTES: Record<string, "GET" | "POST"> = {
  "/overview": "GET",
  "/messages": "GET",
  "/message": "POST",
  "/read": "POST",
  "/channels/create": "POST",
  "/members/add": "POST",
  "/members/remove": "POST",
  "/members/role": "POST",
  "/agents/upsert": "POST",
  "/agents/github-validate": "POST",
  "/agents/delete": "POST",
  "/agents/slack-create-app": "POST",
  "/agents/slack-install-url": "POST",
  "/slack-config": "POST",
  "/screens/upsert": "POST",
  "/screens/delete": "POST",
  "/intercom/inbox": "POST",
  "/intercom/thread": "POST",
  "/intercom/details": "POST",
  "/intercom/reply": "POST",
  "/intercom/suggest": "POST",
  "/intercom/suggest/rate": "POST",
  "/intercom/action": "POST",
  "/intercom/ask-gera": "POST",
  "/intercom/stats": "POST",
  "/intercom/stats/refresh": "POST",
  "/intercom/stats/clear": "POST",
  "/intercom/stats/link": "POST",
  "/intercom/slack-related": "POST",
  "/intercom/ask-status": "POST",
  "/tracking/setup": "POST",
  "/screen-chat": "GET",
  "/screen-chat/send": "POST",
  "/project/rename": "POST",
  "/project/delete": "POST",
};

/** Dispatches one call to a ProjectStore DO instance (registry or shard). */
function projectStoreFetch(
  relay: ProjectRelayContext,
  requestUrl: string,
  doId: string,
  path: string,
  options: { method: "GET" | "POST"; body?: string; email?: string; headers?: Record<string, string> },
): Promise<Response> {
  const target = new URL(path, new URL(requestUrl).origin);
  const headers = new Headers();
  headers.set("X-Rork-DO-Class", "ProjectStore");
  headers.set("X-Rork-DO-Id", doId);
  if (options.email) {
    headers.set("X-Gera-Email", encodeURIComponent(options.email));
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers.set(key, value);
  }
  return relay.durable.fetch(new Request(target.toString(), { method: options.method, headers, body: options.body }));
}

/**
 * Post-commit side effects of project writes, run via waitUntil so the
 * response returns instantly:
 * - /message: fire the queued agent replies (the shard runs the engine and
 *   fills the placeholder; polling clients pick the text up when it lands);
 * - membership / rename / delete: mirror the change into the registry
 *   singleton so GET /projects stays correct for everyone involved.
 */
async function projectPostEffects(
  relay: ProjectRelayContext,
  requestUrl: string,
  projectId: string,
  email: string,
  sub: string,
  requestBody: string,
  responseText: string,
): Promise<void> {
  try {
    if (sub === "/message") {
      const data = JSON.parse(responseText) as { jobs?: unknown };
      const jobs = Array.isArray(data.jobs) ? data.jobs.filter((id): id is string => typeof id === "string") : [];
      for (const jobId of jobs.slice(0, 3)) {
        const run = await projectStoreFetch(relay, requestUrl, `proj:${projectId}`, "/agent-run", {
          method: "POST",
          email,
          body: JSON.stringify({ jobId }),
        });
        if (!run.ok) {
          console.error("project agent-run failed", run.status);
        }
      }
      return;
    }
    if (sub === "/screen-chat/send" || sub === "/intercom/ask-gera") {
      // The desk assistant reply (and "Ask Gera" research) runs inside the
      // shard, same as channel jobs.
      const data = JSON.parse(responseText) as { jobs?: unknown };
      const jobs = Array.isArray(data.jobs) ? data.jobs.filter((id): id is string => typeof id === "string") : [];
      for (const jobId of jobs.slice(0, 1)) {
        const run = await projectStoreFetch(relay, requestUrl, `proj:${projectId}`, "/screen-run", {
          method: "POST",
          email,
          body: JSON.stringify({ jobId }),
        });
        if (!run.ok) {
          console.error("project screen-run failed", run.status);
        }
      }
      return;
    }
    const upsert = (payload: unknown): Promise<Response> =>
      projectStoreFetch(relay, requestUrl, "registry", "/reg/upsert", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    if (sub === "/members/add" || sub === "/members/role") {
      const body = JSON.parse(requestBody) as { email?: unknown; role?: unknown };
      const target = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (target) {
        await upsert({
          projectId,
          rows: [{ email: target, role: body.role === "admin" ? "admin" : "member" }],
        });
      }
      return;
    }
    if (sub === "/members/remove") {
      const body = JSON.parse(requestBody) as { email?: unknown };
      const target = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (target) {
        await upsert({ projectId, drop: [target] });
      }
      return;
    }
    if (sub === "/project/rename") {
      const data = JSON.parse(responseText) as { name?: unknown };
      if (typeof data.name === "string" && data.name.length > 0) {
        await upsert({ projectId, name: data.name });
      }
      return;
    }
    if (sub === "/project/delete") {
      await projectStoreFetch(relay, requestUrl, "registry", "/reg/drop-project", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
    }
  } catch (error) {
    console.error("project post-effects failed", sub, error instanceof Error ? error.message : "error");
  }
}

const SLACK_EVENT_BODY_LIMIT = 64_000;

/**
 * /slack/events/:projectId/:agentId — the public Slack Events API endpoint
 * that turns a project agent into a mentionable Slack bot. No Gera identity
 * here by design (Slack is the caller): the project shard proves authenticity
 * with the per-agent signing secret (v0 HMAC over the raw body + 5-minute
 * timestamp window + event-id dedup). The relay answers Slack within its 3s
 * budget and fires the queued mention run via waitUntil — the same pattern
 * as channel agent replies. Bodies and tokens are never logged.
 */
export async function relaySlackEvents(relay: ProjectRelayContext, request: Request, url: URL, ctx: ExecutionCtx): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return relay.corsJson({ error: "method_not_allowed" }, 405);
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = (segments[2] ?? "").slice(0, 64);
    const agentId = (segments[3] ?? "").slice(0, 64);
    if (segments.length !== 4 || !/^[a-zA-Z0-9]+$/.test(projectId) || !/^[a-zA-Z0-9]+$/.test(agentId)) {
      return relay.corsJson({ error: "not_found" }, 404);
    }
    const body = await request.text();
    if (body.length > SLACK_EVENT_BODY_LIMIT) {
      return relay.corsJson({ error: "body_too_large" }, 413);
    }
    const upstream = await projectStoreFetch(relay, request.url, `proj:${projectId}`, "/slack-event", {
      method: "POST",
      body,
      headers: {
        "X-Gera-Slack-Agent": agentId,
        "X-Slack-Signature": request.headers.get("X-Slack-Signature") ?? "",
        "X-Slack-Request-Timestamp": request.headers.get("X-Slack-Request-Timestamp") ?? "",
      },
    });
    const text = await upstream.text();
    console.log("slack events relay", upstream.status);
    if (upstream.ok) {
      try {
        const data = JSON.parse(text) as { jobs?: unknown };
        const jobs = Array.isArray(data.jobs)
          ? data.jobs.filter((id): id is string => typeof id === "string")
          : [];
        for (const jobId of jobs.slice(0, 1)) {
          ctx.waitUntil(
            projectStoreFetch(relay, request.url, `proj:${projectId}`, "/slack-run", {
              method: "POST",
              body: JSON.stringify({ jobId }),
            }).then((run) => {
              if (!run.ok) {
                console.error("slack bot run dispatch failed", run.status);
              }
            }),
          );
        }
      } catch {
        // non-JSON upstream body — pass it through untouched
      }
    }
    return new Response(text, {
      status: upstream.status,
      headers: { ...relay.corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("slack events relay failed", error instanceof Error ? error.message : "error");
    return relay.corsJson({ error: "internal" }, 500);
  }
}

const PAGE_VIEW_BODY_LIMIT = 16_000;

/**
 * POST /pv/:projectId — the public "Recent page views" beacon. The caller is
 * the customer's website (Gera's pv.js snippet), so there is no Gera identity
 * by design; the project shard verifies the write-only tracking key inside
 * the payload. Bodies are size-capped and never logged.
 */
export async function relayPageViews(relay: ProjectRelayContext, request: Request, url: URL): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return relay.corsJson({ error: "method_not_allowed" }, 405);
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = (segments[1] ?? "").slice(0, 64);
    if (segments.length !== 2 || !/^[a-zA-Z0-9]+$/.test(projectId)) {
      return relay.corsJson({ error: "not_found" }, 404);
    }
    const body = await request.text();
    if (body.length > PAGE_VIEW_BODY_LIMIT) {
      return relay.corsJson({ error: "body_too_large" }, 413);
    }
    const upstream = await projectStoreFetch(relay, request.url, `proj:${projectId}`, "/pv-ingest", {
      method: "POST",
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...relay.corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("pv relay failed", error instanceof Error ? error.message : "error");
    return relay.corsJson({ error: "internal" }, 500);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Tiny human-readable page for the Slack install tab — no assets, honest copy. */
function slackCallbackPage(ok: boolean, title: string, message: string): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;display:grid;place-items:center;min-height:100vh;background:#141210;color:#f4eee3;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
  main{max-width:26rem;padding:2.5rem 1.5rem;text-align:center}
  .dot{display:inline-flex;width:3rem;height:3rem;border-radius:9999px;align-items:center;justify-content:center;font-size:1.35rem;background:${ok ? "rgba(16,185,129,.16)" : "rgba(245,158,11,.16)"}}
  h1{font-size:1.15rem;margin:1rem 0 .5rem}
  p{margin:0;color:#b5ac9c}
</style></head>
<body><main>
  <span class="dot">${ok ? "\u2713" : "!"}</span>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</main></body></html>`;
  return new Response(body, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * GET /slack/oauth/callback — Slack lands here after the admin authorizes the
 * bot install. The state's plain part only routes to the project shard; the
 * shard verifies the HMAC (keyed by the app's client secret) and swaps the
 * code for the bot token server-side. Renders a small human page — this tab
 * was opened from the agent editor, which picks the result up by polling.
 */
export async function relaySlackOAuthCallback(relay: ProjectRelayContext, request: Request, url: URL): Promise<Response> {
  try {
    if (request.method !== "GET") {
      return relay.corsJson({ error: "method_not_allowed" }, 405);
    }
    const denied = url.searchParams.get("error");
    if (denied) {
      return slackCallbackPage(
        false,
        "Install cancelled",
        `Slack reported "${denied}" — nothing was installed. Close this tab and retry from Gera.`,
      );
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const payload = decodeSlackInstallState(state);
    if (!code || !payload) {
      return slackCallbackPage(
        false,
        "Invalid install link",
        "This link is malformed or expired — go back to Gera and click Install again.",
      );
    }
    const upstream = await projectStoreFetch(relay, request.url, `proj:${payload.projectId}`, "/slack-oauth", {
      method: "POST",
      body: JSON.stringify({ agentId: payload.agentId, code, state }),
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    console.log("slack oauth callback", upstream.status);
    if (!upstream.ok) {
      const message =
        typeof data.message === "string" && data.message.length > 0
          ? data.message
          : `The install could not be completed (${typeof data.error === "string" ? data.error : upstream.status}). Retry from Gera.`;
      return slackCallbackPage(false, "Install failed", message);
    }
    const team = typeof data.team === "string" && data.team.length > 0 ? data.team : "your workspace";
    return slackCallbackPage(
      true,
      "Slack bot installed",
      `The bot is now in ${team}. Back in Gera the editor updates by itself — /invite the bot to a channel and @mention it.`,
    );
  } catch (error) {
    console.error("slack oauth callback failed", error instanceof Error ? error.message : "error");
    return slackCallbackPage(false, "Install failed", "Unexpected error — try again from Gera.");
  }
}

/**
 * /projects/* — team workspaces: scoped agents (e.g. read-only repo guides,
 * Intercom support desks) plus Slack-style channels with threads. Identity +
 * invite gate here; membership and roles are enforced inside each project's
 * ProjectStore shard. Agent replies fire via waitUntil after the message
 * commits, so posting never blocks on an LLM run.
 */
export async function relayProjects(relay: ProjectRelayContext, request: Request, url: URL, ctx: ExecutionCtx): Promise<Response> {
  try {
    const account = await relay.requireInvitedAccount(request);
    if (account instanceof Response) {
      return account;
    }
    const email = account.storageOwner;

    if (request.method === "GET" && url.pathname === "/projects") {
      const upstream = await projectStoreFetch(
        relay,
        request.url,
        "registry",
        `/reg/list?email=${encodeURIComponent(email)}`,
        { method: "GET" },
      );
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...relay.corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/projects/create") {
      const raw = await request.text();
      if (raw.length > 4_096) {
        return relay.corsJson({ error: "body_too_large" }, 413);
      }
      let parsed: { name?: unknown; ownerName?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        return relay.corsJson({ error: "invalid_json" }, 400);
      }
      const name = typeof parsed.name === "string" ? parsed.name.trim().slice(0, 60) : "";
      if (!name) {
        return relay.corsJson({ error: "invalid_name" }, 400);
      }
      const projectId = `p${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const init = await projectStoreFetch(relay, request.url, `proj:${projectId}`, "/init", {
        method: "POST",
        email,
        body: JSON.stringify({
          projectId,
          name,
          ownerName: typeof parsed.ownerName === "string" ? parsed.ownerName.slice(0, 60) : "",
        }),
      });
      if (!init.ok) {
        const text = await init.text();
        return new Response(text, {
          status: init.status,
          headers: { ...relay.corsHeaders, "Content-Type": "application/json" },
        });
      }
      await projectStoreFetch(relay, request.url, "registry", "/reg/upsert", {
        method: "POST",
        body: JSON.stringify({ projectId, name, rows: [{ email, role: "owner" }] }),
      });
      console.log("project created");
      return relay.corsJson({ ok: true, id: projectId, name }, 200);
    }

    const match = /^\/projects\/(p[a-f0-9]{20})(\/.+)$/.exec(url.pathname);
    if (!match) {
      return relay.corsJson({ error: "not_found" }, 404);
    }
    const projectId = match[1];
    const sub = match[2];
    const expected = PROJECT_SUB_ROUTES[sub];
    if (!expected || request.method !== expected) {
      return relay.corsJson({ error: "not_found" }, 404);
    }
    let body: string | undefined;
    if (expected === "POST") {
      body = await request.text();
      if (body.length > PROJECT_BODY_LIMIT) {
        return relay.corsJson({ error: "body_too_large" }, 413);
      }
      if (sub === "/agents/upsert") {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          const incomingSecrets =
            parsed.secrets && typeof parsed.secrets === "object" && !Array.isArray(parsed.secrets)
              ? { ...(parsed.secrets as Record<string, unknown>) }
              : {};
          const fromAccount = incomingSecrets.githubFromAccount === true;
          delete incomingSecrets.githubFromAccount;
          delete incomingSecrets.githubAccount;
          if (fromAccount) {
            const proof = await relay.accountAuthorizationLease(request.url, account, "github", false);
            if (!proof) {
              return relay.corsJson({ error: "github_sign_in_required" }, 409);
            }
            incomingSecrets.githubAccount = { owner: email, serverId: "github" };
          } else if (incomingSecrets.githubToken === null) {
            incomingSecrets.githubAccount = null;
          }
          parsed.secrets = incomingSecrets;
          body = JSON.stringify(parsed);
        } catch {
          return relay.corsJson({ error: "invalid_json" }, 400);
        }
      }
    }
    const upstream = await projectStoreFetch(relay, request.url, `proj:${projectId}`, `${sub}${url.search}`, {
      method: expected,
      email,
      body,
    });
    const text = await upstream.text();
    if (upstream.ok && expected === "POST") {
      ctx.waitUntil(projectPostEffects(relay, request.url, projectId, email, sub, body ?? "", text));
    }
    if (upstream.ok && sub === "/members/add") {
      // Honest hint: project membership does not grant Gera access — the
      // added email still needs an app invite to sign in at all.
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        const added = typeof data.email === "string" ? data.email : "";
        const invited = added ? await relay.isInvitedCached(request.url, added) : false;
        return relay.corsJson({ ...data, invited }, upstream.status);
      } catch {
        // fall through to the raw response
      }
    }
    const quiet =
      sub === "/messages" ||
      sub === "/overview" ||
      sub === "/read" ||
      sub === "/message" ||
      sub === "/screen-chat" ||
      sub === "/screen-chat/send" ||
      sub === "/intercom/inbox" ||
      sub === "/intercom/thread" ||
      sub === "/intercom/details" ||
      sub === "/intercom/suggest" ||
      sub === "/intercom/stats" ||
      sub === "/intercom/slack-related" ||
      sub === "/intercom/ask-status";
    if (!quiet) {
      console.log("projects", request.method, sub, upstream.status);
    }
    return new Response(text, {
      status: upstream.status,
      headers: { ...relay.corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("projects relay failed", error instanceof Error ? error.message : "error");
    return relay.corsJson({ error: "upstream_unreachable" }, 502);
  }
}
