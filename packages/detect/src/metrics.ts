// Turning a recorded run into per-case, per-metric samples.
//
// GRADING HAPPENS HERE, FROM RAW TEXT, EVERY TIME. Nothing is read back from a stored verdict. The
// rule comes from `toolcall-risk-classifier/src/toolcall_risk/bench/frontier.py`, where a stored
// parse went stale and every refusal in a 494-call run had been scored as a confident answer until
// someone audited it. Re-deriving means a grader fix re-grades every archived run for free.
//
// It is also what makes this project's own calibration affordable: the A/A study and the power
// curve re-grade the same recorded outputs thousands of times, and if grading were baked in at
// collection time the detector could only be calibrated by paying for new calls.
//
// AN ERRORED CALL IS DROPPED FROM THE SAMPLE AND COUNTED SEPARATELY. Not scored as a failure, and
// not silently ignored. A provider outage is not a quality regression, and treating it as one would
// make every network problem look like drift. But a rising error rate IS a real signal, so the
// count travels with the samples and the report shows it.
//
// AN UNPARSEABLE OR REFUSING ANSWER IS SCORED AS WRONG, because it is. A model that starts
// declining a prompt it used to answer has drifted, and a harness that retried that away or skipped
// it would be blind to one of the clearest drift signals there is.

import type { RunSnapshot } from "@model-regression-sentinel/run";
import {
  type EvalCase,
  type MetricKey,
  gradeOutput,
  producibleSignals,
} from "@model-regression-sentinel/spec";
import type { CaseSamples } from "./nullCalibration.js";

export interface MetricSamples {
  readonly metric: MetricKey;
  /** True for quality, schemaValid and refusal: values are 0 or 1 and rates are proportions. */
  readonly binary: boolean;
  readonly perCase: readonly CaseSamples[];
  /** Calls that errored and were therefore excluded from every sample above. */
  readonly errorCount: number;
}

/**
 * Extract every metric from a snapshot.
 *
 * `latencyMs` uses `apiMs`, the server-reported figure, because it is the only one of the three
 * that is a property of the provider rather than of this machine. `wallMs` includes subprocess
 * startup and would make a busy laptop look like a drifting provider. Both are recorded in the
 * snapshot and the report prints all three; only this one is compared.
 */
export function extractMetrics(
  cases: readonly EvalCase[],
  snapshot: RunSnapshot,
): ReadonlyMap<MetricKey, MetricSamples> {
  const byId = new Map(cases.map((c) => [String(c.id), c]));
  const accum = new Map<MetricKey, Map<string, number[]>>();
  const errors = new Map<MetricKey, number>();

  const put = (metric: MetricKey, caseId: string, value: number): void => {
    let cases_ = accum.get(metric);
    if (cases_ === undefined) {
      cases_ = new Map();
      accum.set(metric, cases_);
    }
    const bucket = cases_.get(caseId);
    if (bucket === undefined) cases_.set(caseId, [value]);
    else bucket.push(value);
  };

  for (const record of snapshot.records) {
    const evalCase = byId.get(record.caseId);
    if (evalCase === undefined) continue;
    const producible = producibleSignals(evalCase);

    if (record.response.error !== "") {
      for (const metric of producible) errors.set(metric, (errors.get(metric) ?? 0) + 1);
      continue;
    }

    const graded = gradeOutput(evalCase, record.response.text);
    if (producible.has("quality")) put("quality", record.caseId, graded.quality ? 1 : 0);
    if (producible.has("schemaValid") && graded.schemaValid !== null) {
      put("schemaValid", record.caseId, graded.schemaValid ? 1 : 0);
    }
    put("refusal", record.caseId, graded.refused ? 1 : 0);
    put("outputTokens", record.caseId, record.response.outputTokens);
    put("latencyMs", record.caseId, record.response.apiMs);
    put("costUsd", record.caseId, record.response.harnessCostUsd);
  }

  const binary = new Set<MetricKey>(["quality", "schemaValid", "refusal"]);
  const out = new Map<MetricKey, MetricSamples>();
  for (const [metric, cases_] of accum) {
    out.set(metric, {
      metric,
      binary: binary.has(metric),
      perCase: [...cases_.entries()]
        .map(([caseId, values]) => ({ caseId, values }))
        .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0)),
      errorCount: errors.get(metric) ?? 0,
    });
  }
  return out;
}

/** Cases present in both arms, paired by id. A case missing from one arm cannot be paired at all. */
export function pairCases(
  baseline: readonly CaseSamples[],
  candidate: readonly CaseSamples[],
): readonly {
  readonly caseId: string;
  readonly baseline: readonly number[];
  readonly candidate: readonly number[];
}[] {
  const b = new Map(baseline.map((s) => [s.caseId, s.values]));
  const out: { caseId: string; baseline: readonly number[]; candidate: readonly number[] }[] = [];
  for (const c of candidate) {
    const match = b.get(c.caseId);
    if (match === undefined || match.length === 0 || c.values.length === 0) continue;
    out.push({ caseId: c.caseId, baseline: match, candidate: c.values });
  }
  return out.sort((x, y) => (x.caseId < y.caseId ? -1 : x.caseId > y.caseId ? 1 : 0));
}
