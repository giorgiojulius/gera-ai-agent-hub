export function userFacingError(status: number, bodyText?: string): string {
  if (status === 401) {
    return "AI features are currently unavailable. Please restart the app.";
  }
  if (status === 402) {
    return "AI features are temporarily unavailable. Please try again later.";
  }
  if (status === 413) {
    return "Image is too large. Please try a smaller photo.";
  }
  if (status === 429) {
    return "Too many requests. Please wait a moment and try again.";
  }
  if (status >= 500) {
    return "Something went wrong. Please try again.";
  }

  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown; code?: unknown };
      if (parsed.code === "INSUFFICIENT_BALANCE") {
        return "AI features are temporarily unavailable. Please try again later.";
      }
      if (typeof parsed.error === "string" && parsed.error.length > 0 && parsed.error.length < 180) {
        return parsed.error;
      }
      if (typeof parsed.message === "string" && parsed.message.length > 0 && parsed.message.length < 180) {
        return parsed.message;
      }
    } catch {
      // ignore parse errors
    }
  }

  return "Something went wrong. Please try again.";
}

export function errorFromUnknown(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Stopped.";
  }
  if (error instanceof Error && error.message.length > 0 && error.message.length < 220) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export function parseRetryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 30_000);
    }
  }
  return Math.min(800 * 2 ** attempt, 8_000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export type RetryOptions<T> = {
  /** Total attempts including the first one (default 3). */
  attempts?: number;
  signal?: AbortSignal;
  /** First backoff in ms — doubles per retry, capped at 4s (default 700). */
  baseDelayMs?: number;
  /** Treat a resolved value as a transient failure worth retrying (e.g. an empty stream). */
  shouldRetryResult?: (value: T) => boolean;
};

/**
 * Runs an async producer with automatic retries for transient failures
 * (network blips, gateway hiccups, empty streams). Aborts are never retried.
 * Once attempts are exhausted the last error is rethrown; a resolved-but-empty
 * final attempt is returned as-is so the caller's fallback path still runs.
 */
export async function withRetries<T>(run: () => Promise<T>, options: RetryOptions<T> = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 700;
  let lastError: unknown = new Error("Nothing was attempted.");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw abortError();
    }
    if (attempt > 0) {
      await sleep(Math.min(base * 2 ** (attempt - 1), 4_000));
      if (options.signal?.aborted) {
        throw abortError();
      }
    }
    try {
      const value = await run();
      if (attempt < attempts - 1 && options.shouldRetryResult?.(value)) {
        lastError = new Error("the model returned nothing");
        continue;
      }
      return value;
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}
