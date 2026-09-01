import app, {
  AccessRegistry,
  ArenaStore,
  ChatStore,
  ProjectStore,
  RepoPreviewStore,
  ShareStore,
} from "../functions/index";

export { AccessRegistry, ArenaStore, ChatStore, ProjectStore, RepoPreviewStore, ShareStore };

type StagingEnv = {
  ACCESS_REGISTRY: DurableObjectNamespace;
  ARENA_STORE: DurableObjectNamespace;
  CHAT_STORE: DurableObjectNamespace;
  PROJECT_STORE: DurableObjectNamespace;
  REPO_PREVIEW_STORE: DurableObjectNamespace;
  SHARE_STORE: DurableObjectNamespace;
  STAGING_AUTH_SECRET: string;
  STAGING_VERSION?: string;
  CRON_SECRET?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID?: string;
  RORK_AUTH_SECRET_KEY?: string;
  STAGING_GATEWAY_URL?: string;
  STAGING_GATEWAY_SECRET?: string;
};

type SessionPayload = {
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  aud?: unknown;
  exp?: unknown;
};

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifiedSession(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) {
    return null;
  }
  let header: { alg?: unknown };
  let payload: SessionPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]))) as { alg?: unknown };
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]))) as SessionPayload;
  } catch {
    return null;
  }
  if (
    header.alg !== "HS256" ||
    payload.aud !== "gera-staging" ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !payload.email ||
    typeof payload.exp !== "number" ||
    payload.exp <= Math.floor(Date.now() / 1_000)
  ) {
    return null;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  return valid ? payload : null;
}

function namespaceFor(env: StagingEnv, className: string): DurableObjectNamespace | null {
  const namespaces: Record<string, DurableObjectNamespace> = {
    AccessRegistry: env.ACCESS_REGISTRY,
    ArenaStore: env.ARENA_STORE,
    ChatStore: env.CHAT_STORE,
    ProjectStore: env.PROJECT_STORE,
    RepoPreviewStore: env.REPO_PREVIEW_STORE,
    ShareStore: env.SHARE_STORE,
  };
  return namespaces[className] ?? null;
}

function dispatcher(env: StagingEnv): { fetch(request: Request): Promise<Response> } {
  return {
    fetch(request: Request): Promise<Response> {
      const className = request.headers.get("X-Rork-DO-Class") ?? "";
      const objectName = request.headers.get("X-Rork-DO-Id") ?? "";
      const namespace = namespaceFor(env, className);
      if (!namespace || !objectName) {
        return Promise.resolve(Response.json({ error: "unknown_durable_object" }, { status: 404 }));
      }
      return namespace.get(namespace.idFromName(objectName)).fetch(request);
    },
  };
}

export default {
  async fetch(request: Request, env: StagingEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__staging/version") {
      return Response.json({ ok: true, version: env.STAGING_VERSION ?? "unknown" });
    }
    const headers = new Headers(request.headers);
    headers.delete("X-Rork-User-Id");
    headers.delete("X-Rork-User-Email");
    headers.delete("X-Rork-User-Name");
    const authorization = headers.get("Authorization") ?? "";
    if (authorization.startsWith("Bearer ")) {
      const session = await verifiedSession(authorization.slice("Bearer ".length), env.STAGING_AUTH_SECRET);
      if (session) {
        headers.set("X-Rork-User-Id", String(session.sub));
        headers.set("X-Rork-User-Email", String(session.email).trim().toLowerCase());
        headers.set("X-Rork-User-Name", typeof session.name === "string" ? session.name : "Staging user");
      }
    }
    const forwarded = new Request(request, { headers });
    const runtimeEnv = { ...env, DO: dispatcher(env) };
    return app.fetch(forwarded, runtimeEnv, ctx);
  },
};
