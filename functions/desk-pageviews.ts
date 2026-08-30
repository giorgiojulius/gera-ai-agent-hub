// First-party "Recent page views" for the screen desk.
//
// Intercom shows recent page views inside its own Inbox, but its public REST
// API does not expose them (probed + documented: the "Recent page views" app
// is Messenger-fed and Inbox-only). So Gera collects its own, the same way
// Intercom does — a tiny snippet on the customer's site beacons page views to
// the Worker, keyed by the visitor's identity. No fake data: only identified
// visitors (email / external user id matching the Intercom contact) appear.
//
// This module is pure (no Cloudflare types) so both the Worker and unit tests
// can import it.

/** One tracked page view on the wire and in the desk details panel. */
export type DeskPageView = { url: string; title: string; at: number };

export type PageViewPayload = {
  key: string;
  /** Lowercased email ("" when the beacon only knows an external user id). */
  email: string;
  /** External user id as a string ("" when only the email is known). */
  userId: string;
  /** Sanitized views, oldest first. */
  views: DeskPageView[];
};

/** Max views accepted per beacon request. */
export const PAGE_VIEW_BATCH_LIMIT = 10;
/** Views older than this are swept on every ingest. */
export const PAGE_VIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Newest N rows kept per contact key. */
export const PAGE_VIEWS_PER_CONTACT = 40;

const URL_LIMIT = 600;
const TITLE_LIMIT = 140;
const PAST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_WINDOW_MS = 5 * 60 * 1000;

function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, TITLE_LIMIT);
}

/** http(s) URLs only — beacons carrying javascript:/data:/garbage are dropped. */
function cleanUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.href.slice(0, URL_LIMIT);
  } catch {
    return "";
  }
}

/**
 * Strict beacon-body parser. Returns null for anything unusable: missing or
 * short key, no identity (the snippet buffers anonymous views client-side, so
 * an unidentified beacon is malformed), or zero valid views. Timestamps are
 * clamped to [now − 7d, now + 5m] so stale buffers stay plausible and clocks
 * from the future cannot pin rows to the top.
 */
export function parsePageViewPayload(raw: unknown, now: number = Date.now()): PageViewPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const key = typeof record.k === "string" ? record.k.trim() : "";
  if (key.length < 8 || key.length > 120) {
    return null;
  }
  const emailRaw = typeof record.email === "string" ? record.email.trim().toLowerCase().slice(0, 200) : "";
  const email = emailRaw.includes("@") ? emailRaw : "";
  const idRaw = record.userId;
  const userId =
    typeof idRaw === "string"
      ? idRaw.trim().slice(0, 120)
      : typeof idRaw === "number" && Number.isFinite(idRaw)
        ? String(idRaw)
        : "";
  if (email.length === 0 && userId.length === 0) {
    return null;
  }
  const viewsRaw = Array.isArray(record.views) ? record.views.slice(0, PAGE_VIEW_BATCH_LIMIT) : [];
  const views: DeskPageView[] = [];
  for (const item of viewsRaw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const view = item as Record<string, unknown>;
    const url = cleanUrl(view.url);
    if (url.length === 0) {
      continue;
    }
    const at =
      typeof view.at === "number" && Number.isFinite(view.at)
        ? Math.min(Math.max(view.at, now - PAST_WINDOW_MS), now + FUTURE_WINDOW_MS)
        : now;
    views.push({ url, title: cleanTitle(view.title), at: Math.round(at) });
  }
  if (views.length === 0) {
    return null;
  }
  views.sort((a, b) => a.at - b.at);
  return { key, email, userId, views };
}

/**
 * Storage/lookup keys for one contact identity. Views are written under every
 * key so the desk matches the Intercom contact by email OR external user id.
 */
export function pageViewContactKeys(email: string, userId: string): string[] {
  const keys: string[] = [];
  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail.includes("@")) {
    keys.push(`em:${cleanEmail.slice(0, 200)}`);
  }
  const cleanId = userId.trim();
  if (cleanId.length > 0) {
    keys.push(`uid:${cleanId.slice(0, 120)}`);
  }
  return keys;
}

/**
 * The tracker served at GET /pv.js. Plain ES5-ish script, ~1.6 KB:
 * - reads its endpoint + write-only key from the script tag's data attributes;
 * - auto-identifies the visitor from window.intercomSettings (the site already
 *   runs Intercom Messenger) with a 12s grace, or via the public
 *   window.geraPageViews.identify(email, userId) API;
 * - tracks the initial load + SPA route changes (pushState/replaceState/
 *   popstate/hashchange), collapsing same-URL repeats within 15s;
 * - buffers up to 20 anonymous views in localStorage and flushes them (in
 *   chunks of 8) once the visitor is identified — pre-login pages survive;
 * - ships beacons via navigator.sendBeacon (text/plain — no preflight) with a
 *   keepalive fetch fallback. Nothing is sent for anonymous visitors.
 */
export const TRACKER_JS = `/* Gera page views — powers "Recent page views" in the Gera desk. */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var endpoint = script.getAttribute("data-endpoint") || "";
  var key = script.getAttribute("data-key") || "";
  if (!endpoint || !key) return;
  var ID_KEY = "gera_pv_identity";
  var BUF_KEY = "gera_pv_buffer";
  var identity = null;
  try { identity = JSON.parse(localStorage.getItem(ID_KEY) || "null"); } catch (e) {}
  function readBuffer() {
    try { return JSON.parse(localStorage.getItem(BUF_KEY) || "[]") || []; } catch (e) { return []; }
  }
  function writeBuffer(list) {
    try { localStorage.setItem(BUF_KEY, JSON.stringify(list.slice(-20))); } catch (e) {}
  }
  function send(views) {
    if (!identity || !views.length) return;
    var body = JSON.stringify({ k: key, email: identity.email || "", userId: identity.userId || "", views: views });
    var sent = false;
    try { sent = !!(navigator.sendBeacon && navigator.sendBeacon(endpoint, body)); } catch (e) {}
    if (!sent) {
      try {
        fetch(endpoint, { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } })["catch"](function () {});
      } catch (e) {}
    }
  }
  function flush() {
    if (!identity) return;
    var buffered = readBuffer();
    if (!buffered.length) return;
    writeBuffer([]);
    for (var i = 0; i < buffered.length; i += 8) send(buffered.slice(i, i + 8));
  }
  var lastUrl = "";
  var lastAt = 0;
  function view() {
    var url = location.href.split("#")[0];
    var now = Date.now();
    if (url === lastUrl && now - lastAt < 15000) return;
    lastUrl = url;
    lastAt = now;
    var item = { url: url.slice(0, 600), title: (document.title || "").slice(0, 140), at: now };
    if (identity) {
      send([item]);
    } else {
      var buffered = readBuffer();
      buffered.push(item);
      writeBuffer(buffered);
    }
  }
  function identify(email, userId) {
    var cleanEmail = (typeof email === "string" ? email : "").trim().toLowerCase();
    var cleanId = userId === null || userId === undefined ? "" : String(userId).trim();
    if (!cleanEmail && !cleanId) return;
    identity = { email: cleanEmail, userId: cleanId };
    try { localStorage.setItem(ID_KEY, JSON.stringify(identity)); } catch (e) {}
    flush();
  }
  var attempts = 0;
  (function autoIdentify() {
    var settings = window.intercomSettings;
    if (settings && (settings.email || settings.user_id)) {
      identify(settings.email, settings.user_id);
      return;
    }
    if (identity) return;
    attempts += 1;
    if (attempts < 12) setTimeout(autoIdentify, 1000);
  })();
  window.geraPageViews = { identify: identify };
  var origPush = history.pushState;
  history.pushState = function () { origPush.apply(this, arguments); view(); };
  var origReplace = history.replaceState;
  history.replaceState = function () { origReplace.apply(this, arguments); view(); };
  window.addEventListener("popstate", view);
  window.addEventListener("hashchange", view);
  view();
  flush();
})();
`;
