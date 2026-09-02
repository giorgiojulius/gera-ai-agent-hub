/**
 * Dependency-free helpers shared by the backend client and the diagnostics
 * journal: attach structured context to any error and scrub credentials out
 * of free text before it can reach the journal, the clipboard, or the cloud.
 */
export type DiagnosticContext = Record<string, unknown>;

const CONTEXT_KEY = "diagnosticContext";

/** Attaches (or merges) journal context onto an error and returns the same error. */
export function withDiagnosticContext<T>(error: T, context: DiagnosticContext): T {
  if (typeof error !== "object" || error === null) {
    return error;
  }
  const holder = error as Record<string, unknown>;
  const existing = holder[CONTEXT_KEY];
  const merged =
    typeof existing === "object" && existing !== null
      ? { ...(existing as DiagnosticContext), ...context }
      : { ...context };
  try {
    Object.defineProperty(holder, CONTEXT_KEY, {
      value: merged,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen error objects keep their message; the journal still gets the stack.
  }
  return error;
}

/** Context previously attached with `withDiagnosticContext`, or null. */
export function diagnosticContextOf(error: unknown): DiagnosticContext | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const value = (error as Record<string, unknown>)[CONTEXT_KEY];
  return typeof value === "object" && value !== null ? (value as DiagnosticContext) : null;
}

const SECRET_JSON_KEYS =
  "accessToken|refreshToken|access_token|refresh_token|id_token|token|secret|client_secret|password|authorization|device_code|apiKey|api_key|headersJson";
const SECRET_QUERY_KEYS = "state|code|token|access_token|refresh_token|key|secret|signature|sig|apikey|api_key";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // JSON fields whose value is a credential — keep the key, drop the value.
  [new RegExp(`("(?:${SECRET_JSON_KEYS})"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`, "gi"), "$1[redacted]$2"],
  // Query-string credentials and one-time OAuth codes.
  [new RegExp(`([?&](?:${SECRET_QUERY_KEYS})=)[^&\\s"']+`, "gi"), "$1[redacted]"],
  // Header-style bearer values, wherever they were echoed.
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/g, "$1 [redacted]"],
  // Provider token shapes.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[redacted-slack-token]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted-key]"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]"],
];

/** Removes credential-shaped substrings; safe to run on any free text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Compact, deterministic rendering of one context value for a journal line. */
export function formatContextValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
