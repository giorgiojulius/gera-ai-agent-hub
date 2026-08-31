import type {
  E2ePlatform,
  E2eRunReport,
  E2eScenario,
  E2eScenarioResult,
  E2eStep,
  E2eStepResult,
} from "./types";

/** Default wait budget for see/seeText steps — generous for CI browsers. */
export const DEFAULT_STEP_TIMEOUT_MS = 10_000;

/**
 * What a platform driver must implement. Web: vitest browser locators over
 * `data-testid`. Mobile (future): Detox/Maestro over the same `testID`
 * registry — implement these methods and the whole scenario catalog plus
 * the shared stats work unchanged.
 */
export type E2eDriver = {
  goto: (path: string) => Promise<void>;
  tap: (target: string) => Promise<void>;
  fill: (target: string, text: string) => Promise<void>;
  see: (target: string, timeoutMs: number) => Promise<void>;
  /** Waits until the target is unmounted or visually hidden (fade-outs count). */
  notSee: (target: string, timeoutMs: number) => Promise<void>;
  seeText: (target: string, text: string, timeoutMs: number) => Promise<void>;
  /** Waits until the current address (path + query) contains the fragment. */
  urlContains: (text: string, timeoutMs: number) => Promise<void>;
};

export function stepLabel(step: E2eStep): string {
  switch (step.do) {
    case "goto":
      return `goto ${step.path}`;
    case "tap":
      return `tap ${step.target}`;
    case "fill":
      return `fill ${step.target}`;
    case "see":
      return `see ${step.target}`;
    case "notSee":
      return `not see ${step.target}`;
    case "seeText":
      return `see "${step.text}" in ${step.target}`;
    case "urlContains":
      return `url contains "${step.text}"`;
  }
}

async function execute(driver: E2eDriver, step: E2eStep): Promise<void> {
  switch (step.do) {
    case "goto":
      return driver.goto(step.path);
    case "tap":
      return driver.tap(step.target);
    case "fill":
      return driver.fill(step.target, step.text);
    case "see":
      return driver.see(step.target, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    case "notSee":
      return driver.notSee(step.target, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    case "seeText":
      return driver.seeText(step.target, step.text, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    case "urlContains":
      return driver.urlContains(step.text, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
  }
}

/**
 * Runs one scenario up to the first failing step. Never throws — failures are
 * data, so a broken step still produces a complete, reportable result.
 */
export async function runScenario(driver: E2eDriver, scenario: E2eScenario): Promise<E2eScenarioResult> {
  const steps: E2eStepResult[] = [];
  const startedAt = Date.now();
  let error: string | undefined;

  for (const [index, step] of scenario.steps.entries()) {
    const stepStart = Date.now();
    try {
      await execute(driver, step);
      steps.push({ index, label: stepLabel(step), ok: true, ms: Date.now() - stepStart });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      steps.push({ index, label: stepLabel(step), ok: false, ms: Date.now() - stepStart, error: message });
      error = `${stepLabel(step)} — ${message}`;
      break;
    }
  }

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    ok: error === undefined && steps.length === scenario.steps.length,
    ms: Date.now() - startedAt,
    steps,
    ...(error ? { error } : {}),
  };
}

export function buildRunReport(params: {
  platform: E2ePlatform;
  app: string;
  startedAt: number;
  results: E2eScenarioResult[];
}): E2eRunReport {
  const passed = params.results.filter((result) => result.ok).length;
  return {
    schema: 1,
    platform: params.platform,
    app: params.app,
    startedAt: new Date(params.startedAt).toISOString(),
    durationMs: Date.now() - params.startedAt,
    passed,
    failed: params.results.length - passed,
    results: params.results,
  };
}
