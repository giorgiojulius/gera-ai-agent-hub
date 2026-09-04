// HTTP auth challenges and OAuth scope strings for the MCP client — pure,
// platform-neutral helpers shared by the OAuth flow (discovery reads the
// `scope` and `resource_metadata` hints of a 401 challenge), the toolset
// (a 403 `insufficient_scope` on tools/call becomes a step-up) and the web
// app's tests. Nothing here touches storage or the network.
//
// References: RFC 9110 §11.6.1 (WWW-Authenticate grammar), RFC 6750 §3
// (Bearer challenge params: realm, scope, error, error_description),
// RFC 9728 §5.1 (`resource_metadata` param), RFC 6749 §3.3 (scope syntax).

/** One parsed challenge: `Bearer realm="x", scope="a b"` → scheme + params. */
export type AuthChallenge = {
  scheme: string;
  /** Lower-cased param names; quoted-string escapes already resolved. */
  params: Record<string, string>;
  /** token68 form (`Basic dXNlcjpwYXNz`) when the challenge carried one. */
  token68?: string;
};

/** The Bearer challenge the MCP server sent with a 401/403, flattened. */
export type BearerChallenge = {
  realm?: string;
  /** RFC 6750 error code (`invalid_token`, `insufficient_scope`, `invalid_request`). */
  error?: string;
  errorDescription?: string;
  /** Scopes the server says the request needs (RFC 6750 §3 `scope`). */
  scope: string[];
  /** RFC 9728 §5.1: where the protected resource metadata lives. */
  resourceMetadata?: string;
};

/** What an auth rejection means for the grant. */
export type McpAuthRejection =
  | {
      /** The credential works but lacks scopes — a wider sign-in fixes it. */
      kind: "step_up";
      code: "insufficient_scope";
      scopes: string[];
      description?: string;
    }
  | {
      /** The credential itself was refused — refresh or a new sign-in. */
      kind: "reauth";
      code: string;
      description?: string;
    };

/** RFC 6749 §3.3 scope-token characters: %x21 / %x23-5B / %x5D-7E. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
/** Bounds for anything user- or server-supplied. */
const MAX_SCOPES = 64;
const MAX_SCOPE_CHARS = 256;

/**
 * Parses a scope string into distinct scope tokens (order kept). Accepts the
 * RFC's space delimiter and, for pasted user input, commas/newlines too.
 * Tokens with characters outside the RFC grammar are dropped rather than sent
 * to a provider that would reject the whole request.
 */
export function parseScopeString(value: unknown): string[] {
  if (Array.isArray(value)) {
    return parseScopeString(value.map((item) => (typeof item === "string" ? item : "")).join(" "));
  }
  if (typeof value !== "string") {
    return [];
  }
  const out: string[] = [];
  for (const raw of value.split(/[\s,]+/)) {
    const token = raw.trim();
    if (!token || token.length > MAX_SCOPE_CHARS || !SCOPE_TOKEN.test(token) || out.includes(token)) {
      continue;
    }
    out.push(token);
    if (out.length >= MAX_SCOPES) {
      break;
    }
  }
  return out;
}

/** Ordered union of scope lists (first occurrence wins). */
export function mergeScopes(...lists: Array<readonly string[] | undefined | null>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const scope of list ?? []) {
      if (scope && !out.includes(scope) && out.length < MAX_SCOPES) {
        out.push(scope);
      }
    }
  }
  return out;
}

/** RFC 6749 §3.3 wire form: space-delimited. */
export function formatScopes(scopes: readonly string[]): string {
  return scopes.join(" ");
}

const TOKEN_CHARS = /[A-Za-z0-9!#$%&'*+.^_`|~-]/;
const TOKEN68_CHARS = /[A-Za-z0-9._~+/-]/;

/**
 * Parses a WWW-Authenticate header (possibly several comma-joined challenges)
 * into scheme + params. Quoted strings may contain commas and escaped quotes;
 * malformed input yields what could be read, never throws.
 */
export function parseWwwAuthenticate(header: string | null | undefined): AuthChallenge[] {
  const input = (header ?? "").trim();
  if (!input) {
    return [];
  }
  const challenges: AuthChallenge[] = [];
  let index = 0;

  const skipSpacesAndCommas = (): void => {
    while (index < input.length && (input[index] === " " || input[index] === "\t" || input[index] === ",")) {
      index += 1;
    }
  };
  const readToken = (): string => {
    const start = index;
    while (index < input.length && TOKEN_CHARS.test(input[index])) {
      index += 1;
    }
    return input.slice(start, index);
  };
  const readQuoted = (): string => {
    // input[index] === '"'
    index += 1;
    let out = "";
    while (index < input.length) {
      const char = input[index];
      if (char === "\\" && index + 1 < input.length) {
        out += input[index + 1];
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        return out;
      }
      out += char;
      index += 1;
    }
    return out;
  };

  while (index < input.length) {
    skipSpacesAndCommas();
    const scheme = readToken();
    if (!scheme) {
      // Unreadable byte: skip it so a stray character cannot loop forever.
      index += 1;
      continue;
    }
    const challenge: AuthChallenge = { scheme, params: {} };
    challenges.push(challenge);
    // Params follow after whitespace; a bare scheme (`Negotiate`) is legal.
    while (index < input.length && (input[index] === " " || input[index] === "\t")) {
      index += 1;
    }
    let sawParam = false;
    for (;;) {
      skipSpacesAndCommas();
      if (index >= input.length) {
        break;
      }
      const save = index;
      const name = readToken();
      if (!name) {
        index += 1;
        continue;
      }
      let cursor = index;
      while (cursor < input.length && (input[cursor] === " " || input[cursor] === "\t")) {
        cursor += 1;
      }
      if (input[cursor] === "=") {
        index = cursor + 1;
        while (index < input.length && (input[index] === " " || input[index] === "\t")) {
          index += 1;
        }
        const value = input[index] === '"' ? readQuoted() : readToken();
        challenge.params[name.toLowerCase()] = value;
        sawParam = true;
        continue;
      }
      // No "=": this is the next challenge's scheme (or a token68 for this one).
      if (!sawParam && TOKEN68_CHARS.test(name[0] ?? "") && (input[cursor] === "=" || input[cursor] === undefined || input[cursor] === ",")) {
        // token68 like `Basic dXNlcg==` — trailing '=' padding belongs to it.
        let token68 = name;
        while (index < input.length && input[index] === "=") {
          token68 += "=";
          index += 1;
        }
        if (token68 !== name || !TOKEN_CHARS.test(name[0] ?? "") || /^[A-Za-z0-9+/]+={1,2}$/.test(token68)) {
          challenge.token68 = token68;
          break;
        }
      }
      index = save;
      break;
    }
  }
  return challenges;
}

/** The Bearer challenge (if any) with scope split into tokens. */
export function bearerChallenge(header: string | null | undefined): BearerChallenge | null {
  const challenge = parseWwwAuthenticate(header).find((item) => item.scheme.toLowerCase() === "bearer");
  if (!challenge) {
    return null;
  }
  const params = challenge.params;
  return {
    ...(params.realm ? { realm: params.realm.slice(0, 200) } : {}),
    ...(params.error ? { error: params.error.slice(0, 80) } : {}),
    ...(params.error_description ? { errorDescription: params.error_description.slice(0, 300) } : {}),
    scope: parseScopeString(params.scope ?? ""),
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata.slice(0, 2_000) } : {}),
  };
}

/**
 * Classifies a 401/403 from the MCP server. `insufficient_scope` (RFC 6750
 * §3.1) — or a 403 whose challenge names scopes — is a step-up: the current
 * grant is valid but too narrow. Everything else means the credential itself
 * was refused.
 */
export function classifyMcpAuthRejection(status: number, wwwAuthenticate: string | null | undefined): McpAuthRejection {
  const challenge = bearerChallenge(wwwAuthenticate);
  const error = challenge?.error?.toLowerCase() ?? "";
  if (error === "insufficient_scope" || (status === 403 && !error && (challenge?.scope.length ?? 0) > 0)) {
    return {
      kind: "step_up",
      code: "insufficient_scope",
      scopes: challenge?.scope ?? [],
      ...(challenge?.errorDescription ? { description: challenge.errorDescription } : {}),
    };
  }
  return {
    kind: "reauth",
    code: error || (status === 403 ? "forbidden" : "invalid_token"),
    ...(challenge?.errorDescription ? { description: challenge.errorDescription } : {}),
  };
}

/** Plain-words tool result / card text for a step-up; never includes credentials. */
export function describeStepUp(serverName: string, scopes: readonly string[]): string {
  const wanted = scopes.length > 0 ? ` (scopes: ${formatScopes(scopes)})` : "";
  return `MCP server "${serverName}" needs a sign-in with wider access${wanted}. Open Settings → MCP and press "Sign in again with wider access"; the server is not contacted again in this run.`;
}
