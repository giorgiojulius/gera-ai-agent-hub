import { withRetries } from "@/lib/errors";

describe("withRetries", () => {
  it("returns the first success without extra calls", async () => {
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        return "ok";
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient failures and continues once one attempt succeeds", async () => {
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("network error");
        }
        return "final";
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("final");
    expect(calls).toBe(3);
  });

  it("throws the last error once attempts are exhausted", async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          throw new Error(`boom ${calls}`);
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("boom 3");
    expect(calls).toBe(3);
  });

  it("never retries an abort", async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          throw new DOMException("Aborted", "AbortError");
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("stops before a retry when the signal is already aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          controller.abort();
          throw new Error("network error");
        },
        { attempts: 3, baseDelayMs: 1, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("retries empty results and returns the last one for the caller's fallback", async () => {
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        return "";
      },
      { attempts: 3, baseDelayMs: 1, shouldRetryResult: (value) => !value },
    );
    expect(result).toBe("");
    expect(calls).toBe(3);
  });

  it("accepts a late non-empty result after empty attempts", async () => {
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        return calls < 2 ? "" : "text";
      },
      { attempts: 3, baseDelayMs: 1, shouldRetryResult: (value) => !value },
    );
    expect(result).toBe("text");
    expect(calls).toBe(2);
  });
});
