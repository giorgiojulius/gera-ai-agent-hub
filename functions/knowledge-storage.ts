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

type StorageEnv = {
  EXPO_PUBLIC_RORK_API_BASE_URL?: string;
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
};

type TempCreds = {
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

let cachedCreds: TempCreds | null = null;
let inflight: Promise<TempCreds> | null = null;

async function fetchTempCreds(env: StorageEnv): Promise<TempCreds> {
  const base = (env.EXPO_PUBLIC_RORK_API_BASE_URL ?? "https://rork.app").replace(/\/+$/, "");
  const secret = env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? env.RORK_TOOLKIT_SECRET_KEY ?? "";
  const response = await fetch(`${base}/api/storage/temp-credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
  });
  if (response.status === 429) {
    throw new Error("storage_quota");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("temp-credentials failed", response.status, text.slice(0, 200));
    throw new Error("storage_unavailable");
  }
  return (await response.json()) as TempCreds;
}

async function getCreds(env: StorageEnv): Promise<TempCreds> {
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

async function presignUrl(creds: TempCreds, method: "PUT" | "GET" | "DELETE", key: string): Promise<string> {
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
      const creds = await getCreds(env);
      return { status: 200, body: { url: await presignUrl(creds, "PUT", key), key } };
    }

    const key = typeof payload.key === "string" ? payload.key : "";
    if (!KEY_PATTERN.test(key) || !key.startsWith(`knowledge/${prefix}/`)) {
      return invalid("bad_key");
    }

    if (url.pathname === "/knowledge/download-url") {
      const creds = await getCreds(env);
      return { status: 200, body: { url: await presignUrl(creds, "GET", key) } };
    }

    if (url.pathname === "/knowledge/delete") {
      const creds = await getCreds(env);
      const deleted = await fetch(await presignUrl(creds, "DELETE", key), { method: "DELETE" });
      if (!deleted.ok && deleted.status !== 404) {
        console.error("knowledge delete failed", deleted.status);
        return { status: 502, body: { error: "delete_failed" } };
      }
      return { status: 200, body: { ok: true } };
    }

    return { status: 404, body: { error: "not_found" } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "storage_unavailable";
    if (message === "storage_quota") {
      return { status: 429, body: { error: "storage_quota" } };
    }
    console.error("knowledge storage error", message);
    return { status: 502, body: { error: "storage_unavailable" } };
  }
}
