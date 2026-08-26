// Running the calibration scenarios and reporting what they found.
//
// A scenario RETURNS its checks rather than throwing, so one failed assertion does not hide the six
// behind it. A grade whose first failure masks the rest tells you where to start rather than what
// is wrong, and for a statistical detector that is a real loss: the interesting information is
// usually the PATTERN of which scenarios failed together.
//
// A thrown scenario becomes data rather than a skip, for the same reason. A crash is a failure and
// is reported as one, but it is reported distinctly, because a mutant whose failures are all
// crashes is a mutant that is catching a broken harness rather than the injected mistake. The
// meta-test checks exactly that.

import type { CheckResult, Detector } from "./detector.js";
import { ALL_SCENARIOS, type CalibrationScenario } from "./scenarios.js";

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  readonly error?: string;
}

export interface CalibrationReport {
  readonly detector: string;
  readonly scenarios: readonly ScenarioResult[];
  readonly passed: boolean;
  readonly summary: { readonly total: number; readonly passed: number; readonly failed: number };
}

const describeError = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

export function runCalibration(
  detector: Detector,
  only?: readonly string[],
  scenarios: readonly CalibrationScenario[] = ALL_SCENARIOS,
): CalibrationReport {
  const selected = only === undefined ? scenarios : scenarios.filter((s) => only.includes(s.id));
  const results: ScenarioResult[] = [];

  for (const scenario of selected) {
    let checks: readonly CheckResult[] = [];
    let error: string | undefined;
    try {
      checks = scenario.run(detector);
    } catch (cause) {
      error = describeError(cause);
    }
    const passed = error === undefined && checks.length > 0 && checks.every((c) => c.passed);
    results.push({
      id: scenario.id,
      title: scenario.title,
      passed,
      checks,
      ...(error === undefined ? {} : { error }),
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  return {
    detector: detector.name,
    scenarios: results,
    passed: results.every((r) => r.passed),
    summary: { total: results.length, passed: passedCount, failed: results.length - passedCount },
  };
}

const pad = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);

/**
 * A readable text table.
 *
 * Failing checks print their observed value underneath. A report that says only FAIL sends the
 * reader back to the source to find out what was measured, which is the moment a suite stops being
 * used.
 */
export function formatCalibration(report: CalibrationReport): string {
  const lines: string[] = [];
  lines.push(`calibration: ${report.detector}`);
  lines.push("-".repeat(96));
  for (const s of report.scenarios) {
    const tally = `${s.checks.filter((c) => c.passed).length}/${s.checks.length}`;
    lines.push(`${s.passed ? "PASS" : "FAIL"}  ${pad(s.id, 3)} ${pad(s.title, 78)} ${tally}`);
    if (s.error !== undefined) lines.push(`        ! ${s.error}`);
    for (const c of s.checks) {
      if (c.passed) continue;
      lines.push(`        x ${c.name}`);
      if (c.detail !== undefined) lines.push(`          ${c.detail}`);
    }
  }
  lines.push("-".repeat(96));
  lines.push(
    `${report.summary.total} scenarios: ${report.summary.passed} passed, ${report.summary.failed} failed`,
  );
  return lines.join("\n");
}
