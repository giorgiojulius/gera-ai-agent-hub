import { logDiagnostic } from "@/lib/diagnostics";
import { getToolkitUrl, newId } from "@/lib/env";
import { parseRetryAfterMs, sleep, userFacingError } from "@/lib/errors";

type ToolkitFetchInit = RequestInit & {
  idempotencyKey?: string;
  retry?: boolean;
};

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function toolkitFetch(path: string, init: ToolkitFetchInit = {}): Promise<Response> {
  const { idempotencyKey, retry = true, headers, ...rest } = init;
  const key = idempotencyKey ?? newId();
  const url = `${getToolkitUrl()}${path.startsWith("/") ? path : `/${path}`}`;

  let lastError: Error | null = null;
  const attempts = retry ? 3 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...rest,
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": key,
          ...(headers ?? {}),
        },
      });

      if (response.ok || !retry || !shouldRetryStatus(response.status) || attempt === attempts - 1) {
        return response;
      }

      const waitMs = parseRetryAfterMs(response.headers.get("Retry-After"), attempt);
      await sleep(waitMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Network error");
      if (!retry || attempt === attempts - 1) {
        throw lastError;
      }
      await sleep(parseRetryAfterMs(null, attempt));
    }
  }

  throw lastError ?? new Error("Something went wrong. Please try again.");
}

export async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  let path = response.url;
  try {
    path = new URL(response.url).pathname;
  } catch {
    // keep the raw URL
  }
  // Every surfaced API failure lands in the local diagnostics journal.
  logDiagnostic("api", `HTTP ${response.status} · ${path}`, text.slice(0, 600));
  return userFacingError(response.status, text);
}

export async function requireJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as T;
}
