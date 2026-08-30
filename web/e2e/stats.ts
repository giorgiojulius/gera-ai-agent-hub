/**
 * Cross-platform E2E stats CLI.
 *
 * Usage:  bun e2e/stats.ts [resultsDir]     (default: e2e-results)
 *
 * Aggregates every `<platform>.latest.json` + `history.jsonl` written by the
 * runners. The web suite writes them via the `saveE2eReport` vitest browser
 * command today; the future mobile driver (ios/android) writes the exact same
 * `E2eRunReport` schema into the same folder — and shows up in this table
 * with zero changes here.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { E2ePlatform, E2eRunReport } from "./types";

const PLATFORMS: E2ePlatform[] = ["web", "ios", "android"];

function isRunReport(value: unknown): value is E2eRunReport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schema?: unknown }).schema === 1 &&
    typeof (value as { platform?: unknown }).platform === "string" &&
    Array.isArray((value as { results?: unknown }).results)
  );
}

function loadLatest(dir: string): Map<E2ePlatform, E2eRunReport> {
  const latest = new Map<E2ePlatform, E2eRunReport>();
  if (!existsSync(dir)) {
    return latest;
  }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".latest.json")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
      if (isRunReport(parsed)) {
        latest.set(parsed.platform, parsed);
      }
    } catch {
      // A corrupt report never breaks the table — it is just skipped.
    }
  }
  return latest;
}

function loadHistory(dir: string): E2eRunReport[] {
  const historyPath = path.join(dir, "history.jsonl");
  if (!existsSync(historyPath)) {
    return [];
  }
  const runs: E2eRunReport[] = [];
  for (const line of readFileSync(historyPath, "utf8").split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunReport(parsed)) {
        runs.push(parsed);
      }
    } catch {
      // skip corrupt lines
    }
  }
  return runs;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function main(): void {
  const dir = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "e2e-results"));
  const latest = loadLatest(dir);
  const history = loadHistory(dir);

  console.log("Gera E2E — cross-platform stats");
  console.log(`results: ${dir}\n`);

  console.log("Latest run per platform");
  for (const platform of PLATFORMS) {
    const run = latest.get(platform);
    if (!run) {
      console.log(
        `  ${platform.padEnd(8)} — no runs yet${platform === "web" ? "" : " (mobile driver plugs into the same scenario catalog)"}`,
      );
      continue;
    }
    const failing = run.results.filter((result) => !result.ok).map((result) => result.scenarioId);
    console.log(
      `  ${platform.padEnd(8)} ${formatWhen(run.startedAt).padEnd(18)} ${`${run.passed}/${run.passed + run.failed}`.padEnd(6)} ${formatDuration(run.durationMs).padEnd(8)}${failing.length > 0 ? ` failing: ${failing.join(", ")}` : ""}`,
    );
  }

  // Pass-rate matrix per scenario, across the whole retained history.
  const scenarioIds = [
    ...new Set(history.flatMap((run) => run.results.map((result) => result.scenarioId))),
  ];
  if (scenarioIds.length === 0) {
    console.log("\nNo history yet — run `bun run e2e` first.");
    return;
  }

  console.log(`\nScenario pass rates (history: ${history.length} run${history.length === 1 ? "" : "s"})`);
  const header = `  ${"scenario".padEnd(28)}${PLATFORMS.map((platform) => platform.padEnd(12)).join("")}`;
  console.log(header);
  for (const scenarioId of scenarioIds) {
    const cells = PLATFORMS.map((platform) => {
      const attempts = history
        .filter((run) => run.platform === platform)
        .flatMap((run) => run.results.filter((result) => result.scenarioId === scenarioId));
      if (attempts.length === 0) {
        return "—".padEnd(12);
      }
      const passed = attempts.filter((result) => result.ok).length;
      const rate = Math.round((passed / attempts.length) * 100);
      return `${passed}/${attempts.length} ${rate}%`.padEnd(12);
    });
    console.log(`  ${scenarioId.padEnd(28)}${cells.join("")}`);
  }

  const slowest = [...(latest.get("web")?.results ?? [])].sort((a, b) => b.ms - a.ms)[0];
  if (slowest) {
    console.log(`\nSlowest web scenario: ${slowest.scenarioId} (${formatDuration(slowest.ms)})`);
  }
}

main();
