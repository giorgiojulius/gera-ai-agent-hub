/** Shared outbound-network guard for relays and cloud MCP/OAuth calls. */

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".test",
  ".example",
  ".invalid",
  ".nip.io",
  ".sslip.io",
  ".xip.io",
  ".localtest.me",
  ".lvh.me",
  ".vcap.me",
  ".traefik.me",
  ".local.gd",
] as const;

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return null;
  }
  const parts = host.split(".").map(Number);
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isNonPublicIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Words(value: string): number[] | null {
  let source = value;
  const dottedMatch = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(source);
  if (dottedMatch) {
    const ipv4 = parseIpv4(dottedMatch[2]);
    if (!ipv4) {
      return null;
    }
    source = `${source.slice(0, dottedMatch.index + dottedMatch[1].length)}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((word) => Number.parseInt(word, 16));
}

function embeddedIpv4(ipv6: string): number[] | null {
  const words = ipv6Words(ipv6);
  if (!words) {
    return null;
  }
  const tail = (): number[] => [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255];
  const isZeroPrefix = words.slice(0, 6).every((word) => word === 0);
  const isMapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const isNat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  const isLocalNat64 = words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1;
  if (isZeroPrefix || isMapped || isNat64 || isLocalNat64) {
    return tail();
  }
  if (words[0] === 0x2002) {
    return [words[1] >> 8, words[1] & 255, words[2] >> 8, words[2] & 255];
  }
  return null;
}

/** True for local, private, link-local, documentation, benchmark, and multicast hosts. */
export function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !host ||
    host === "localhost" ||
    host === "metadata.google.internal" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix)) ||
    (!host.includes(".") && !host.includes(":"))
  ) {
    return true;
  }
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    return isNonPublicIpv4(ipv4);
  }
  if (host.includes(":")) {
    const embedded = embeddedIpv4(host);
    if (embedded && isNonPublicIpv4(embedded)) {
      return true;
    }
    return (
      host === "::" ||
      host === "::1" ||
      /^(?:fc|fd)/i.test(host) ||
      /^fe[89ab]/i.test(host) ||
      /^ff/i.test(host) ||
      /^2001:(?:0|db8)(?::|$)/i.test(host)
    );
  }
  return false;
}

/** Parses an absolute public HTTPS URL with no embedded username/password. */
export function safePublicHttpsUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    isForbiddenHost(parsed.hostname)
  ) {
    return null;
  }
  return parsed;
}

const DNS_CACHE_MS = 5 * 60_000;
const dnsCache = new Map<string, { expiresAt: number; isPublic: boolean }>();

/** Resolves A + AAAA through Cloudflare and rejects any private answer. */
export async function assertPublicDns(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (parseIpv4(host) || host.includes(":")) {
    if (isForbiddenHost(host)) {
      throw new Error("outbound host is not public");
    }
    return;
  }
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.isPublic) {
      throw new Error("outbound DNS resolved to a non-public address");
    }
    return;
  }
  const lookup = async (type: "A" | "AAAA"): Promise<string[]> => {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name", host);
    endpoint.searchParams.set("type", type);
    const response = await fetch(endpoint.toString(), {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(4_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error("public DNS safety lookup failed");
    }
    const payload = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    return (payload.Answer ?? [])
      .filter((answer) => answer.type === 1 || answer.type === 28)
      .map((answer) => answer.data ?? "")
      .filter(Boolean);
  };
  const answers = (await Promise.all([lookup("A"), lookup("AAAA")])).flat();
  const isPublic = answers.length > 0 && answers.every((answer) => !isForbiddenHost(answer));
  if (dnsCache.size > 2_000) {
    dnsCache.clear();
  }
  dnsCache.set(host, { expiresAt: Date.now() + DNS_CACHE_MS, isPublic });
  if (!isPublic) {
    throw new Error("outbound DNS resolved to a non-public address");
  }
}

/** Fetches a public HTTPS URL and validates every redirect before following it. */
export async function fetchPublicHttps(
  value: string,
  init: RequestInit,
  options: { maxRedirects?: number; allowCrossOriginGet?: boolean; verifyDns?: boolean } = {},
): Promise<Response> {
  let current = safePublicHttpsUrl(value);
  if (!current) {
    throw new Error("outbound URL is not a public HTTPS endpoint");
  }
  const maxRedirects = options.maxRedirects ?? 5;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (options.verifyDns === true) {
      await assertPublicDns(current.hostname);
    }
    const response = await fetch(current.toString(), {
      ...init,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("outbound redirect had no location");
    }
    const next = safePublicHttpsUrl(new URL(location, current).toString());
    if (!next) {
      throw new Error("outbound redirect target is not allowed");
    }
    if (next.origin !== current.origin) {
      if ((method !== "GET" && method !== "HEAD") || options.allowCrossOriginGet !== true) {
        throw new Error("cross-origin outbound redirect refused");
      }
      headers = new Headers({ Accept: headers.get("Accept") ?? "*/*" });
    }
    if (response.status === 303 && method !== "HEAD") {
      method = "GET";
      body = undefined;
      headers.delete("Content-Type");
    }
    current = next;
  }
  throw new Error("too many outbound redirects");
}
