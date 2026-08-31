import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "path";

import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** History keeps this many most recent runs (all platforms combined). */
const HISTORY_MAX_RUNS = 500;

/**
 * Node-side sink for E2E run reports produced inside the browser suite.
 * Writes e2e-results/<platform>.latest.json plus append-only history.jsonl —
 * exactly the files `bun run e2e:stats` aggregates. The future mobile app's
 * driver writes the same `E2eRunReport` schema into the same folder, so the
 * stats stay cross-platform without touching this code.
 */
async function saveE2eReport(_ctx: unknown, report: unknown): Promise<{ savedTo: string }> {
  const dir = path.resolve(__dirname, "e2e-results");
  mkdirSync(dir, { recursive: true });
  const platform =
    report && typeof report === "object" && typeof (report as { platform?: unknown }).platform === "string"
      ? (report as { platform: string }).platform
      : "web";
  const latestPath = path.join(dir, `${platform}.latest.json`);
  writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`);

  const historyPath = path.join(dir, "history.jsonl");
  const lines = existsSync(historyPath)
    ? readFileSync(historyPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
    : [];
  lines.push(JSON.stringify(report));
  writeFileSync(historyPath, `${lines.slice(-HISTORY_MAX_RUNS).join("\n")}\n`);
  return { savedTo: latestPath };
}

export default defineConfig({
  plugins: [react()],
  // Match the production Vite build: Rork's shared public envs include auth
  // configuration used by browser-only session-expiry regression tests.
  envPrefix: ["VITE_", "EXPO_PUBLIC_"],
  test: {
    globals: true,
    include: ["src/**/*.browser.{test,spec}.{ts,tsx}"],
    testTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      // Desktop width: the persistent sidebar (lg breakpoint) must be
      // visible for the e2e click flows.
      viewport: { width: 1280, height: 900 },
      instances: [{ browser: "chromium" }],
      commands: { saveE2eReport },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
