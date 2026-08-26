// MUTANT. Models: treating the first threshold crossing as proof.
//
// The most reasonable-sounding mistake in this file. The statistics are all correct: the permutation
// test is sound, the noise floor is measured, the effect clears both. The only thing missing is the
// second, independently collected run.
//
// It matters because a threshold is crossed by noise on exactly the run where noise crosses it, and
// the report of that run looks identical to a report of a real regression. Requiring the finding to
// reproduce on fresh data turns one test at alpha into two, which costs one more collection and
// removes almost all of the single-crossing false alarms. A tool that fails builds without it is a
// tool whose failures get overridden.

import { type Detector, referenceDetector } from "../detector.js";

export const noConfirmation: Detector = {
  name: "M6 noConfirmation",
  compare: (cases, baseline, candidate, options) => {
    const real = referenceDetector.compare(cases, baseline, candidate, options);
    // THE BUG: a suspected finding is promoted to confirmed with no second run behind it.
    if (real.verdict !== "SUSPECTED_DRIFT") return real;
    return {
      ...real,
      verdict: "CONFIRMED_DRIFT",
      reason: "the effect cleared both nulls once",
      confirmedMetrics: real.suspectedMetrics,
      suspectedMetrics: [],
    };
  },
  watchRound: referenceDetector.watchRound,
};
