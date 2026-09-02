import { expect, test } from "vitest";

import { repoPreviewSandboxShim, rewriteRepoPreviewHtml } from "../../../functions/repo-preview-shared";

type Probe = { ok: boolean; stage: string; detail: string };

/**
 * Same probe an SPA effectively runs while booting: read/write storage, then
 * report. Runs inside a sandboxed iframe that mirrors the preview's opaque
 * origin, so this exercises the exact browser behaviour the Worker's shim is
 * meant to absorb.
 */
const PROBE_SCRIPT = `<script>
(function () {
  var stage = "start";
  try {
    stage = "typeof";
    if (typeof localStorage === "undefined") throw new Error("localStorage undefined");
    stage = "localStorage";
    localStorage.setItem("gera.token", "abc");
    if (localStorage.getItem("gera.token") !== "abc") throw new Error("localStorage lost the value");
    if (localStorage.length !== 1 || localStorage.key(0) !== "gera.token") throw new Error("length/key mismatch");
    localStorage.theme = "dark";
    if (localStorage.getItem("theme") !== "dark" || localStorage.theme !== "dark") throw new Error("property access mismatch");
    localStorage.removeItem("theme");
    if (localStorage.getItem("theme") !== null) throw new Error("remove failed");
    stage = "sessionStorage";
    sessionStorage.setItem("gera.session", "1");
    if (sessionStorage.getItem("gera.session") !== "1") throw new Error("sessionStorage lost the value");
    if (localStorage.getItem("gera.session") !== null) throw new Error("stores are not separate");
    stage = "cookie";
    document.cookie = "a=1; path=/";
    document.cookie = "b=2";
    if (document.cookie !== "a=1; b=2") throw new Error("cookie jar mismatch: " + document.cookie);
    document.cookie = "a=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    if (document.cookie !== "b=2") throw new Error("cookie expiry mismatch: " + document.cookie);
    parent.postMessage({ ok: true, stage: "done", detail: "" }, "*");
  } catch (error) {
    parent.postMessage({ ok: false, stage: stage, detail: String(error && error.message ? error.message : error) }, "*");
  }
})();
</script>`;

function runInOpaqueSandbox(html: string): Promise<Probe> {
  return new Promise<Probe>((resolve, reject) => {
    const frame = document.createElement("iframe");
    // Exactly the preview's iframe + CSP posture: scripts, no same-origin.
    frame.setAttribute("sandbox", "allow-scripts");
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("sandboxed probe never reported"));
    }, 10_000);
    const onMessage = (event: MessageEvent<Probe>) => {
      if (event.source !== frame.contentWindow) return;
      cleanup();
      resolve(event.data);
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
    };
    window.addEventListener("message", onMessage);
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

test("an opaque-origin sandbox blocks web storage — the reason unshimmed SPAs render an empty page", async () => {
  const probe = await runInOpaqueSandbox(`<!doctype html><html><head></head><body>${PROBE_SCRIPT}</body></html>`);
  expect(probe.ok).toBe(false);
  expect(["typeof", "localStorage"]).toContain(probe.stage);
  expect(probe.detail.toLowerCase()).toMatch(/sandbox|security|denied|access/);
});

test("the served preview HTML boots storage and cookies inside the same sandbox", async () => {
  const served = rewriteRepoPreviewHtml(
    `<!doctype html><html><head><title>p</title></head><body>${PROBE_SCRIPT}</body></html>`,
    "/repo-preview/p.abc/",
  );
  expect(served).toContain(repoPreviewSandboxShim());
  const probe = await runInOpaqueSandbox(served);
  expect(probe).toEqual({ ok: true, stage: "done", detail: "" });
});

test("the shim leaves working storage alone", async () => {
  // No sandbox attribute: same-origin storage works, so the shim must not replace it.
  const frame = document.createElement("iframe");
  frame.srcdoc = `<!doctype html><html><head>${repoPreviewSandboxShim()}</head><body></body></html>`;
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  const inner = frame.contentWindow as Window & typeof globalThis;
  expect(inner.localStorage).toBeInstanceOf(inner.Storage);
  expect(inner.sessionStorage).toBeInstanceOf(inner.Storage);
  frame.remove();
});
