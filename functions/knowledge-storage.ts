// Knowledge cloud storage — full texts of large knowledge files live as R2
// objects under a per-account prefix (`knowledge/<sha256(email)[0..24]>/…`),
// while the synced profile blob keeps only a short local excerpt plus the
// object key. These routes mint short-lived presigned URLs so the browser
// PUTs/GETs bytes directly against R2; the Worker never proxies file bodies.
//
// There are NO static R2 keys: short-lived bucket-scoped credentials are
// fetched from the Rork API with the toolkit secret, cached in a module
// global, and re-fetched near expiry (single-flight). SigV4 presigning is
// implemented manually on crypto.subtle — no SDK, Worker-native, zero deps.

export type RorkStorageEnv = {
  EXPO_PUBLIC_RORK_API_BASE_URL?: string;
  EXPO_PUBLIC_RORK_AUTH_URL?: string;
  RORK_AUTH_URL?: string;
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
};

type StorageEnv = RorkStorageEnv;

export type RorkStorageCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bucket: string;
  endpoint: string;
  expiresAt: string;
};

type RouteResult = { status: number; body: unknown };

/** Presigned URLs are short-lived by design; the client never persists them. */
const URL_TTL_SECONDS = 300;
/** 2M chars of UTF-8 tops out near 8 MiB; this leaves honest headroom. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
/** Re-fetch the credential once it is this close to expiry. */
const REFRESH_MARGIN_MS = 60_000;

const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_PATTERN = /^knowledge\/[a-f0-9]{24}\/[A-Za-z0-9_-]{1,64}\.txt$/;

// --- temp credential cache (module global; survives on a warm isolate) ---

type TempCreds = RorkStorageCredentials;

/** The public Rork API host — the last resort when no configured base serves storage. */
const DEFAULT_RORK_API_BASE = "https://api.rork.com";
const CREDENTIALS_PATH = "/api/storage/temp-credentials";
/** A dead host must not stall a preview claim; the next candidate gets its turn. */
const CANDIDATE_TIMEOUT_MS = 8_000;
/** Error code prefix; the text after the colon is a secret-free, human-readable reason. */
export const STORAGE_UNAVAILABLE = "storage_unavailable";

let cachedCreds: TempCreds | null = null;
let inflight: Promise<TempCreds> | null = null;
/** The base that last minted credentials — tried first on the next refresh. */
let resolvedBase: string | null = null;

function normalizeBase(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
}

/**
 * Where the temp-credentials endpoint may live, most specific first. The
 * documented variable is tried first, but a project's API base can point at a
 * per-project dev host that does not serve `/api/storage` at all (it answers
 * 404 HTML), so the Rork auth host — same API surface — and the public API
 * host back it up. Duplicates collapse; malformed values are skipped.
 */
export function rorkStorageApiCandidates(env: RorkStorageEnv): string[] {
  const out: string[] = [];
  for (const raw of [
    env.EXPO_PUBLIC_RORK_API_BASE_URL,
    env.EXPO_PUBLIC_RORK_AUTH_URL,
    env.RORK_AUTH_URL,
    DEFAULT_RORK_API_BASE,
  ]) {
    const base = normalizeBase(raw);
    if (base && !out.includes(base)) {
      out.push(base);
    }
  }
  return out;
}

function isTempCreds(value: unknown): value is TempCreds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ["accessKeyId", "secretAccessKey", "sessionToken", "bucket", "endpoint", "expiresAt"].every(
    (key) => typeof record[key] === "string" && (record[key] as string).length > 0,
  );
}

/** The `error` code of a JSON error body, or null when the body is not the Rork API's. */
async function apiErrorCode(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object") {
    return null;
  }
  const code = (body as Record<string, unknown>).error;
  return typeof code === "string" && code.length > 0 ? code : null;
}

async function requestCreds(base: string, secret: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANDIDATE_TIMEOUT_MS);
  try {
    // Manual redirects: a misconfigured base that 301s elsewhere must read as
    // "wrong host", not be silently replayed as a GET against a marketing site.
    return await fetch(`${base}${CREDENTIALS_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mints credentials from the first candidate that gives an authoritative
 * answer. Authoritative: valid credentials, or a JSON error from the Rork API
 * (401 unauthorized, 403 storage_not_enabled, 429 over_quota). Everything
 * else — unreachable, timeout, redirect, 404 HTML, 5xx — means "wrong or
 * dead host" and the next candidate is tried. Failures carry a secret-free
 * reason so the user sees what actually happened instead of an opaque code.
 */
async function fetchTempCreds(env: StorageEnv): Promise<TempCreds> {
  const secret = env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? env.RORK_TOOLKIT_SECRET_KEY ?? "";
  if (!secret) {
    throw new Error(`${STORAGE_UNAVAILABLE}:no_toolkit_secret`);
  }
  const candidates = rorkStorageApiCandidates(env);
  const ordered = resolvedBase && candidates.includes(resolvedBase)
    ? [resolvedBase, ...candidates.filter((base) => base !== resolvedBase)]
    : candidates;
  const failures: string[] = [];
  for (const base of ordered) {
    const host = new URL(base).host;
    let response: Response;
    try {
      response = await requestCreds(base, secret);
    } catch (error) {
      failures.push(`${host} ${error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable"}`);
      continue;
    }
    if (response.status === 429) {
      throw new Error("storage_quota");
    }
    if (response.status === 401 || response.status === 403) {
      const code = await apiErrorCode(response);
      if (code) {
        throw new Error(`${STORAGE_UNAVAILABLE}:${response.status} ${code}`);
      }
      failures.push(`${host} ${response.status}`);
      continue;
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as unknown;
      if (isTempCreds(body)) {
        resolvedBase = base;
        return body;
      }
      failures.push(`${host} ${response.status} unexpected body`);
      continue;
    }
    failures.push(`${host} ${response.status}`);
  }
  resolvedBase = null;
  const reason = failures.join("; ").slice(0, 240);
  console.error("temp-credentials failed", reason);
  throw new Error(`${STORAGE_UNAVAILABLE}:${reason}`);
}

export async function getRorkStorageCredentials(env: RorkStorageEnv): Promise<RorkStorageCredentials> {
  if (cachedCreds && new Date(cachedCreds.expiresAt).getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return cachedCreds;
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetchTempCreds(env)
    .then((creds) => {
      cachedCreds = creds;
      return creds;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export type RorkStorageProbe =
  | { ok: true; bucket: string; apiHost: string; expiresAt: string }
  | { ok: false; error: string };

/**
 * Secret-free health probe: can this Worker mint storage credentials right
 * now, and which API host answered? Never returns key material.
 */
export async function probeRorkStorage(env: RorkStorageEnv): Promise<RorkStorageProbe> {
  try {
    const creds = await getRorkStorageCredentials(env);
    return {
      ok: true,
      bucket: creds.bucket,
      apiHost: resolvedBase ? new URL(resolvedBase).host : "",
      expiresAt: creds.expiresAt,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : STORAGE_UNAVAILABLE };
  }
}

// --- manual SigV4 presigning (query auth, UNSIGNED-PAYLOAD, host-only) ---

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/** RFC 3986 strict encoding — SigV4 rejects the laxer encodeURIComponent set. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A presigned URL cannot outlive the credential that signs it. */
function effectiveTtl(creds: TempCreds): number {
  const remaining = Math.max(0, Math.floor((new Date(creds.expiresAt).getTime() - Date.now()) / 1000));
  return Math.min(URL_TTL_SECONDS, remaining);
}

export async function presignRorkStorageUrl(
  creds: RorkStorageCredentials,
  method: "PUT" | "GET" | "DELETE",
  key: string,
): Promise<string> {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const endpoint = creds.endpoint.replace(/\/+$/, "");
  const host = new URL(endpoint).host;
  const canonicalUri = `/${rfc3986(creds.bucket)}/${key.split("/").map(rfc3986).join("/")}`;
  const canonicalQuery = (
    [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${creds.accessKeyId}/${scope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(effectiveTtl(creds))],
      ["X-Amz-Security-Token", creds.sessionToken],
      ["X-Amz-SignedHeaders", "host"],
    ] as const
  )
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(encoder.encode(`AWS4${creds.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  return `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ------------------------------------------------------------------ routes

/** The caller's private key prefix — accounts can never read each other's docs. */
async function emailPrefix(email: string): Promise<string> {
  return (await sha256Hex(email)).slice(0, 24);
}

function invalid(message: string): RouteResult {
  return { status: 400, body: { error: message } };
}

/**
 * Dispatches one /knowledge/* request for an already-authenticated, invited
 * caller. Returns status+body; the caller wraps them with CORS.
 */
export async function handleKnowledgeRoute(
  request: Request,
  url: URL,
  env: StorageEnv,
  email: string,
): Promise<RouteResult> {
  if (request.method !== "POST") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return invalid("invalid_json");
  }

  try {
    const prefix = await emailPrefix(email);

    if (url.pathname === "/knowledge/upload-url") {
      const docId = typeof payload.docId === "string" ? payload.docId : "";
      const contentLength = typeof payload.contentLength === "number" ? payload.contentLength : NaN;
      if (!DOC_ID_PATTERN.test(docId)) {
        return invalid("bad_doc_id");
      }
      if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_UPLOAD_BYTES) {
        return invalid("bad_content_length");
      }
      const key = `knowledge/${prefix}/${docId}.txt`;
      const creds = await getRorkStorageCredentials(env);
      return { status: 200, body: { url: await presignRorkStorageUrl(creds, "PUT", key), key } };
    }

    const key = typeof payload.key === "string" ? payload.key : "";
    if (!KEY_PATTERN.test(key) || !key.startsWith(`knowledge/${prefix}/`)) {
      return invalid("bad_key");
    }

    if (url.pathname === "/knowledge/download-url") {
      const creds = await getRorkStorageCredentials(env);
      return { status: 200, body: { url: await presignRorkStorageUrl(creds, "GET", key) } };
    }

    if (url.pathname === "/knowledge/delete") {
      const creds = await getRorkStorageCredentials(env);
      const deleted = await fetch(await presignRorkStorageUrl(creds, "DELETE", key), { method: "DELETE" });
      if (!deleted.ok && deleted.status !== 404) {
        console.error("knowledge delete failed", deleted.status);
        return { status: 502, body: { error: "delete_failed" } };
      }
      return { status: 200, body: { ok: true } };
    }

    return { status: 404, body: { error: "not_found" } };
  } catch (error) {
    const message = error instanceof Error ? error.message : STORAGE_UNAVAILABLE;
    if (message === "storage_quota") {
      return { status: 429, body: { error: "storage_quota" } };
    }
    console.error("knowledge storage error", message);
    const detail = message.startsWith(`${STORAGE_UNAVAILABLE}:`) ? message.slice(STORAGE_UNAVAILABLE.length + 1) : "";
    return { status: 502, body: detail ? { error: STORAGE_UNAVAILABLE, detail } : { error: STORAGE_UNAVAILABLE } };
  }
}
