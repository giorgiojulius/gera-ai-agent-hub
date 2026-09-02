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
    const onMessage = (event: MessageEvent<Probe | { source?: string }>) => {
      if (event.source !== frame.contentWindow) return;
      // The shim's own bridge traffic (route/title reports) is not the probe's verdict.
      if ((event.data as { source?: string }).source === "gera-preview") return;
      cleanup();
      resolve(event.data as Probe);
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

type BridgeMessage =
  | { source: "gera-preview"; type: "open"; url: string; target: string; id?: string; features?: string }
  | { source: "gera-preview"; type: "state"; href: string; title: string }
  | { source: "gera-preview"; type: "close" | "focus"; id: string }
  | { source: "gera-preview"; type: "message"; id: string; data: unknown; targetOrigin: string }
  | { source: "probe"; results: { kind: string; ok: boolean }[] };

/**
 * Collects every message the frame posts until the probe's final report;
 * `respond` lets the test play Gera and answer the frame like the real host.
 */
function collectFromOpaqueSandbox(
  html: string,
  respond?: (frame: HTMLIFrameElement, message: BridgeMessage) => void,
): Promise<BridgeMessage[]> {
  return new Promise<BridgeMessage[]>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    const received: BridgeMessage[] = [];
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`sandboxed probe never finished: ${JSON.stringify(received)}`));
    }, 10_000);
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== frame.contentWindow) return;
      received.push(event.data);
      if (event.data.source === "probe") {
        cleanup();
        resolve(received);
        return;
      }
      respond?.(frame, event.data);
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

const POPUP_PROBE = `<script>
(function () {
  var results = [];
  document.title = "Storefront · Login";
  var w = window.open("/settings?tab=1");
  results.push({ kind: "open-returns-window-like", ok: !!w && w.closed === false && typeof w.close === "function" });
  var a = document.createElement("a");
  a.href = "https://accounts.example/login";
  a.target = "_blank";
  a.textContent = "Sign in";
  document.body.appendChild(a);
  var ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  a.dispatchEvent(ev);
  results.push({ kind: "blank-anchor-prevented", ok: ev.defaultPrevented });
  var plain = document.createElement("a");
  plain.href = "https://accounts.example/inline";
  document.body.appendChild(plain);
  var plainSeen = null;
  // The shim listens in the capture phase, so this target-phase listener observes its verdict,
  // then stops the real navigation so the probe frame survives.
  plain.addEventListener("click", function (e) { plainSeen = e.defaultPrevented; e.preventDefault(); });
  plain.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  results.push({ kind: "plain-anchor-untouched", ok: plainSeen === false });
  var later = window.open("about:blank", "oauth", "popup,width=560,height=720");
  later.location.href = "https://auth.example/start?state=1";
  var blocked = window.open("javascript:alert(1)");
  results.push({ kind: "javascript-open-stubbed", ok: !!blocked });
  // The OAuth pattern every popup sign-in uses: wait for the callback page's message or for the window to close.
  var callback = null;
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "rork_auth_callback") callback = { code: e.data.code, origin: e.origin };
  });
  later.postMessage({ hello: "popup" }, "https://auth.example");
  var tries = 0;
  var wait = setInterval(function () {
    tries += 1;
    if (!(callback && later.closed) && tries < 150) return;
    clearInterval(wait);
    results.push({ kind: "callback-relayed", ok: !!callback && callback.code === "abc" && callback.origin === "https://auth.example" });
    results.push({ kind: "closed-relayed", ok: later.closed === true });
    w.close();
    results.push({ kind: "close-marks-closed", ok: w.closed === true });
    parent.postMessage({ source: "probe", results: results }, "*");
  }, 20);
})();
</script>`;

test("inside the sandbox the shim bridges popups and the page state to the embedding Gera page", async () => {
  const served = rewriteRepoPreviewHtml(
    `<!doctype html><html><head><title>p</title></head><body>${POPUP_PROBE}</body></html>`,
    "/repo-preview/p.abc/",
  );
  // Play Gera: once the OAuth window is "open", its callback page posts back and the window closes.
  const messages = await collectFromOpaqueSandbox(served, (frame, message) => {
    if (message.source !== "gera-preview" || message.type !== "open" || !message.id || !message.url.startsWith("https://auth.example/")) return;
    const target = frame.contentWindow as Window;
    target.postMessage(
      { source: "gera-preview-host", type: "message", id: message.id, origin: "https://auth.example", data: { type: "rork_auth_callback", code: "abc" } },
      "*",
    );
    target.postMessage({ source: "gera-preview-host", type: "closed", id: message.id }, "*");
  });

  const probe = messages.find((message) => message.source === "probe");
  expect(probe && probe.source === "probe" ? probe.results : []).toEqual([
    { kind: "open-returns-window-like", ok: true },
    { kind: "blank-anchor-prevented", ok: true },
    { kind: "plain-anchor-untouched", ok: true },
    { kind: "javascript-open-stubbed", ok: true },
    { kind: "callback-relayed", ok: true },
    { kind: "closed-relayed", ok: true },
    { kind: "close-marks-closed", ok: true },
  ]);

  const opens = messages.flatMap((message) => (message.source === "gera-preview" && message.type === "open" ? [message] : []));
  // Relative popups resolve against the served <base>, i.e. inside the artifact root.
  expect(opens.map((message) => message.url)).toEqual([
    `${location.origin}/repo-preview/p.abc/settings?tab=1`,
    "https://accounts.example/login",
    "https://auth.example/start?state=1",
  ]);
  expect(opens[2]?.target).toBe("oauth");
  // `window.open` calls carry a popup id and the app's placement hints; anchor clicks carry neither.
  expect(opens[0]?.id).toMatch(/^w[0-9]+$/);
  expect(opens[1]?.id).toBeUndefined();
  expect(opens[2]?.id).toMatch(/^w[0-9]+$/);
  expect(opens[2]?.features).toBe("popup,width=560,height=720");

  const outbound = messages.find((message) => message.source === "gera-preview" && message.type === "message");
  expect(outbound && outbound.source === "gera-preview" && outbound.type === "message" ? outbound : null).toEqual({
    source: "gera-preview",
    type: "message",
    id: opens[2]?.id,
    data: { hello: "popup" },
    targetOrigin: "https://auth.example",
  });
  const closes = messages.flatMap((message) => (message.source === "gera-preview" && message.type === "close" ? [message] : []));
  expect(closes.map((message) => message.id)).toEqual([opens[0]?.id]);

  const states = messages.flatMap((message) => (message.source === "gera-preview" && message.type === "state" ? [message] : []));
  expect(states.length).toBeGreaterThan(0);
  expect(states.map((message) => message.title)).toContain("Storefront · Login");
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
