// The seam a calibration scenario grades, and the reference implementation behind it.
//
// Every scenario is written against this interface rather than against `compare` directly, which is
// what makes it possible to point the same scenarios at a deliberately broken detector and require
// it to fail. That is the whole mechanism by which "the scenarios passed" becomes a statement about
// the detector instead of a statement about the scenarios.

import type { RunSnapshot } from "@model-regression-sentinel/run";
import type { EvalCase } from "@model-regression-sentinel/spec";
import { type CompareOptions, type CompareResult, compare } from "./compare.js";
import {
  DEFAULT_ECONFIG,
  type EProcessConfig,
  type EProcessState,
  observeMany,
} from "./eprocess.js";

/** One graded assertion. `detail` carries what was actually observed, for a failing report. */
export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export const check = (name: string, passed: boolean, detail?: string): CheckResult =>
  detail === undefined ? { name, passed } : { name, passed, detail };

export const expectEqual = <T>(name: string, actual: T, expected: T): CheckResult =>
  check(name, actual === expected, `expected ${String(expected)}, saw ${String(actual)}`);

export interface WatchOutcome {
  readonly state: EProcessState;
  readonly alarmed: boolean;
}

export interface Detector {
  readonly name: string;
  compare(
    cases: readonly EvalCase[],
    baseline: RunSnapshot,
    candidate: RunSnapshot,
    options?: CompareOptions,
  ): CompareResult;
  /** One watch round: fold a set of pass/fail outcomes and say whether the watch is alarmed. */
  watchRound(
    state: EProcessState,
    outcomes: readonly boolean[],
    config?: EProcessConfig,
  ): WatchOutcome;
}

export const referenceDetector: Detector = {
  name: "reference",
  compare: (cases, baseline, candidate, options) => compare(cases, baseline, candidate, options),
  watchRound: (state, outcomes, config = DEFAULT_ECONFIG) => {
    const next = observeMany(state, outcomes, config);
    return { state: next, alarmed: next.alarmed };
  },
};
