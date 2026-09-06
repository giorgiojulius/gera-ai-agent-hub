// Repository-preview relays of the Worker — the authenticated control plane
// (/repo-previews/*), the public hook surface the GitHub Actions runner calls
// back into, the streamed archive upload and the registry touch / sweep.
// Moved verbatim out of index.ts: the Worker lends the DO binding, the
// internal registry secret, CORS helpers, bounded body reads and its account
// gate through RepoPreviewRelayContext.

import { REPO_PREVIEW_MAX_ARCHIVE_BYTES, verifyRepoPreviewId } from "./repo-preview-shared";

/** The slice of the Worker's verified account principal these relays touch. */
export type RepoPreviewRelayAccount = { storageOwner: string };

/** What index.ts lends the repository-preview relays. */
export type RepoPreviewRelayContext<A extends RepoPreviewRelayAccount = RepoPreviewRelayAccount> = {
  /** Durable Object namespace binding — RepoPreviewStore registry and per-owner shards. */
  durable: { fetch(request: Request): Promise<Response> };
  /** Worker secret behind the internal registry routes and the preview-id HMAC. */
  authSecretKey: string | undefined;
  corsHeaders: Record<string, string>;
  corsJson(data: unknown, status: number): Response;
  readBoundedText(request: Request, limit: number): Promise<string | null>;
  /** Platform identity + invite gate; a Response means "answer with this". */
  requireInvitedAccount(request: Request): Promise<A | Response>;
  /** Short-lived GitHub authorization proof from the account shard. */
  accountAuthorizationLease(requestUrl: string, account: A, serverId: string, force: boolean): Promise<string | null>;
};

async function repoPreviewHmac(secret: string, value: string): Promise<string> {
  if (!secret) throw new Error("repo_preview_shard_secret_unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable opaque account shard for repository preview jobs. */
async function repoPreviewOwnerKey(email: string, relay: RepoPreviewRelayContext): Promise<string> {
  return (await repoPreviewHmac(relay.authSecretKey ?? "", email)).slice(0, 24);
}

function repoPreviewStoreRequest(
  relay: RepoPreviewRelayContext,
  requestUrl: string,
  ownerKey: string,
  path: string,
  init: { method: string; headers?: Headers; body?: BodyInit | null },
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Rork-DO-Class", "RepoPreviewStore");
  headers.set("X-Rork-DO-Id", `repo-preview:${ownerKey}`);
  return relay.durable.fetch(
    new Request(new URL(path, new URL(requestUrl).origin).toString(), {
      method: init.method,
      headers,
      body: init.body,
    }),
  );
}

async function touchRepoPreviewRegistry(
  relay: RepoPreviewRelayContext,
  requestUrl: string,
  ownerKey: string,
  nextAt: number,
): Promise<void> {
  if (!relay.authSecretKey) throw new Error("repo_preview_registry_secret_unavailable");
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Gera-Internal-Secret": relay.authSecretKey,
  });
  const response = await repoPreviewStoreRequest(relay, requestUrl, "registry", "/internal/touch", {
    method: "POST",
    headers,
    body: JSON.stringify({ ownerKey, nextAt }),
  });
  if (!response.ok) {
    throw new Error(`repo_preview_registry_touch_${response.status}`);
  }
}

export async function sweepRepoPreviewRegistry(relay: RepoPreviewRelayContext, origin: string): Promise<void> {
  if (!relay.authSecretKey) return;
  const headers = new Headers({ "X-Gera-Internal-Secret": relay.authSecretKey });
  const response = await repoPreviewStoreRequest(relay, origin, "registry", "/internal/sweep", {
    method: "POST",
    headers,
  });
  if (!response.ok) {
    console.error("repo preview registry sweep failed", response.status);
  }
}

/** Authenticated control plane: inspect, setup PR, launch, status, cancel. */
export async function relayRepoPreviews(relay: RepoPreviewRelayContext, request: Request, url: URL): Promise<Response> {
  const account = await relay.requireInvitedAccount(request);
  if (account instanceof Response) {
    return account;
  }
  const email = account.storageOwner;
  const path = url.pathname.slice("/repo-previews".length) || "/";
  const allowed =
    (request.method === "GET" && path === "/status") ||
    (request.method === "POST" && ["/inspect", "/install", "/start", "/cancel"].includes(path));
  if (!allowed) {
    return relay.corsJson({ error: "not_found" }, 404);
  }
  let body: string | undefined;
  if (request.method === "POST") {
    const bounded = await relay.readBoundedText(request, 32_000);
    if (bounded === null) {
      return relay.corsJson({ error: "body_too_large" }, 413);
    }
    body = bounded;
  }
  let ownerKey: string;
  try {
    ownerKey = await repoPreviewOwnerKey(email, relay);
  } catch {
    return relay.corsJson({ error: "preview_backend_unavailable" }, 503);
  }
  const headers = new Headers();
  headers.set("X-Gera-Email", encodeURIComponent(email));
  headers.set("X-Gera-Preview-Owner-Key", ownerKey);
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const reference = request.headers.get("X-Gera-Upstream-Authorization") ?? "";
  let github = "";
  if (reference) {
    const match = /^gera-account:([A-Za-z0-9_-]{1,80})$/.exec(reference);
    if (!match) return relay.corsJson({ error: "server_owned_github_required" }, 400);
    github = (await relay.accountAuthorizationLease(request.url, account, match[1], false)) ?? "";
  }
  if (github) {
    headers.set("X-Gera-GitHub-Authorization", github);
  }
  if (path === "/start") {
    try {
      await touchRepoPreviewRegistry(relay, request.url, ownerKey, Date.now() + 10 * 60_000);
    } catch {
      return relay.corsJson({ error: "preview_maintenance_unavailable" }, 503);
    }
  }
  const upstream = await repoPreviewStoreRequest(
    relay,
    request.url,
    ownerKey,
    `${path}${url.search}`,
    { method: request.method, headers, body },
  );
  const text = await upstream.text();
  if (path !== "/status") {
    console.log("repo previews", request.method, path, upstream.status);
  }
  return new Response(text, {
    status: upstream.status,
    headers: { ...relay.corsHeaders, "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
}

/**
 * Public artifact/hook plane. Signed ids route to an existing account shard;
 * hooks require GitHub OIDC and assets require a separate DO-checked read capability.
 */
export async function relayRepoPreviewPublic(relay: RepoPreviewRelayContext, request: Request, url: URL): Promise<Response> {
  const isHook = url.pathname.startsWith("/repo-preview-hook/");
  const prefix = isHook ? "/repo-preview-hook/" : "/repo-preview/";
  const rest = url.pathname.slice(prefix.length);
  const id = rest.split("/", 1)[0] ?? "";
  if (!(await verifyRepoPreviewId(id, relay.authSecretKey ?? ""))) {
    return new Response("Preview not found", { status: 404 });
  }
  const ownerKey = id.split(".", 1)[0] ?? "";
  const targetPath = `${isHook ? "/hook/" : "/asset/"}${rest}${url.search}`;
  const headers = new Headers(request.headers);
  const hookAuthorization = isHook ? headers.get("Authorization") ?? "" : "";
  headers.delete("X-Gera-GitHub-OIDC");
  if (hookAuthorization.startsWith("Bearer ") && hookAuthorization.length <= 20_007) {
    headers.set("X-Gera-GitHub-OIDC", hookAuthorization.slice("Bearer ".length));
  }
  headers.delete("Authorization");
  headers.delete("X-Rork-User-Id");
  headers.delete("X-Rork-User-Email");
  headers.delete("X-Rork-User-Name");
  if (isHook && request.method === "PUT" && rest === `${id}/archive`) {
    return relayRepoPreviewArchive(request, relay, ownerKey, id, headers);
  }
  const upstream = await repoPreviewStoreRequest(relay, request.url, ownerKey, targetPath, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
}

type FixedLengthStreamConstructor = new (
  expectedLength: number,
) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/**
 * Gives the outgoing PUT an exact Content-Length (R2 rejects chunked bodies)
 * and fails the transfer if the runner sends more or fewer bytes than declared.
 */
function fixedLengthBody(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const FixedLength = (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor }).FixedLengthStream;
  if (!FixedLength) {
    return body;
  }
  const { readable, writable } = new FixedLength(length);
  // A length mismatch or an aborted client surfaces on the fetch side.
  body.pipeTo(writable).catch(() => undefined);
  return readable;
}

function hookJson(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Runner artifact upload. The Durable Object stays a control plane: it
 * authenticates the runner (GitHub OIDC), claims the row and mints a
 * short-lived presigned PUT; this entrypoint streams the tar straight into
 * R2 without buffering and reports the outcome back. The multi-megabyte
 * body therefore never rides the DO transport, and any storage failure is
 * persisted as a specific preview error instead of surfacing as an opaque 5xx.
 */
async function relayRepoPreviewArchive(
  request: Request,
  relay: RepoPreviewRelayContext,
  ownerKey: string,
  id: string,
  hookHeaders: Headers,
): Promise<Response> {
  const contentType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-tar") {
    return hookJson({ error: "unsupported_content_type" }, 415);
  }
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  const body = request.body;
  if (!body || !Number.isInteger(contentLength) || contentLength <= 0 || contentLength > REPO_PREVIEW_MAX_ARCHIVE_BYTES) {
    return hookJson({ error: "invalid_archive_size" }, 413);
  }
  const control = new Headers({ "Content-Type": "application/json" });
  const oidc = hookHeaders.get("X-Gera-GitHub-OIDC");
  if (oidc) {
    control.set("X-Gera-GitHub-OIDC", oidc);
  }
  const claim = await repoPreviewStoreRequest(relay, request.url, ownerKey, `/hook/${id}/archive-claim`, {
    method: "POST",
    headers: control,
    body: JSON.stringify({ contentLength }),
  });
  if (!claim.ok) {
    await body.cancel().catch(() => undefined);
    console.error("repo preview archive claim refused", claim.status);
    return new Response(claim.body, { status: claim.status, headers: claim.headers });
  }
  const granted = (await claim.json().catch(() => null)) as { uploadUrl?: unknown; stagingKey?: unknown } | null;
  const uploadUrl = typeof granted?.uploadUrl === "string" ? granted.uploadUrl : "";
  const stagingKey = typeof granted?.stagingKey === "string" ? granted.stagingKey : "";
  let status = 0;
  let failure = "";
  if (!uploadUrl || !stagingKey) {
    failure = "The preview store returned an invalid upload grant.";
    await body.cancel().catch(() => undefined);
  } else {
    try {
      const upload = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/x-tar" },
        body: fixedLengthBody(body, contentLength),
      });
      status = upload.status;
      await upload.body?.cancel().catch(() => undefined);
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 200) : "transfer failed";
    }
  }
  if (status < 200 || status >= 300 || failure) {
    console.error("repo preview archive transfer failed", status, failure ? "transfer_error" : "rejected");
  }
  const commit = await repoPreviewStoreRequest(relay, request.url, ownerKey, `/hook/${id}/archive-commit`, {
    method: "POST",
    headers: control,
    body: JSON.stringify({ stagingKey, contentLength, status, failure }),
  });
  return new Response(commit.body, { status: commit.status, headers: commit.headers });
}
