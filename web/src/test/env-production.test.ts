import { describe, expect, test } from "vitest";

import envProduction from "../../.env.production?raw";

/**
 * The only settings a build outside Rork (a Repo Preview built from GitHub)
 * may receive from the repository: public, client-inlined identifiers the
 * browser bundle already exposes. Anything else must stay in the project env.
 */
const ALLOWED_KEYS: readonly string[] = [
  "EXPO_PUBLIC_RORK_AUTH_URL",
  "EXPO_PUBLIC_RORK_APP_KEY",
  "EXPO_PUBLIC_RORK_FUNCTIONS_URL",
  "EXPO_PUBLIC_TOOLKIT_URL",
  "EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID",
];

function parse(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    expect(eq, `malformed line: ${line}`).toBeGreaterThan(0);
    out.push([line.slice(0, eq), line.slice(eq + 1)]);
  }
  return out;
}

describe("web/.env.production", () => {
  test("carries exactly the public client settings and never a secret", () => {
    const entries = parse(envProduction);
    expect(entries.map(([key]) => key).sort()).toEqual([...ALLOWED_KEYS].sort());
    for (const [key, value] of entries) {
      expect(key).toMatch(/^EXPO_PUBLIC_[A-Z0-9_]+$/);
      expect(key).not.toMatch(/SECRET|PRIVATE|TOKEN|PASSWORD/);
      expect(value.length).toBeGreaterThan(0);
      expect(value).not.toMatch(/\s|^["']/);
      if (key.endsWith("_URL")) {
        expect(value).toMatch(/^https:\/\/[^\s/]+/);
      }
    }
  });
});
