/**
 * Shared E2E contract: scenario DSL + run report schema.
 *
 * Everything here is pure data with zero dependencies so the same files can
 * be consumed by the web driver (vitest browser mode) today and by the mobile
 * app's driver (Detox/Maestro over React Native testIDs) tomorrow. All
 * platforms emit the SAME `E2eRunReport` shape, which is what makes
 * cross-platform stats (`e2e/stats.ts`) possible.
 */

/** Where a run happened. Mobile drivers report the same schema. */
export type E2ePlatform = "web" | "ios" | "android";

/**
 * The verbs every platform driver can execute. Targets are testids from
 * `src/lib/testids.ts` — web queries `data-testid`, mobile queries `testID`.
 */
export type E2eStep =
  | { do: "goto"; path: string }
  | { do: "tap"; target: string }
  | { do: "fill"; target: string; text: string }
  | { do: "see"; target: string; timeoutMs?: number }
  /** Asserts the target is unmounted or visually hidden (fade-outs count). */
  | { do: "notSee"; target: string; timeoutMs?: number }
  | { do: "seeText"; target: string; text: string; timeoutMs?: number }
  /** Asserts the current address (path + query) contains the fragment. */
  | { do: "urlContains"; text: string; timeoutMs?: number };

export type E2eScenario = {
  /** Stable id — the key stats aggregate by, across platforms and time. */
  id: string;
  title: string;
  steps: E2eStep[];
};

export type E2eStepResult = {
  index: number;
  label: string;
  ok: boolean;
  ms: number;
  error?: string;
};

export type E2eScenarioResult = {
  scenarioId: string;
  title: string;
  ok: boolean;
  ms: number;
  steps: E2eStepResult[];
  /** First failing step's message; absent when the scenario passed. */
  error?: string;
};

/** One full run of the scenario catalog on one platform. */
export type E2eRunReport = {
  schema: 1;
  platform: E2ePlatform;
  /** App identifier, e.g. "gera-web" or "gera-mobile". */
  app: string;
  startedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  results: E2eScenarioResult[];
};
