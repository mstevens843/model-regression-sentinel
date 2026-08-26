// MUTANT. Models: the vacuously honest detector, and the most dangerous one in this file.
//
// It never reports drift. It therefore has a PERFECT false-positive rate, never fails a build for
// no reason, never wakes anyone at night, and would look outstanding on any dashboard built from
// the honesty properties alone. It is also completely useless, and nothing in scenarios 01, 03, 04,
// 05, 07 or 08 can tell it apart from a correct detector, because every one of those scenarios asks
// the detector NOT to do something.
//
// This is the drift-detection form of the sibling's `selfRevoke`: an implementation that satisfies
// every safety property by never doing any work. It is shipped so that the anti-vacuity scenarios
// cannot quietly stop being enforced, and its `mustFail` list is exactly the set of scenarios that
// require the detector to actually detect something.

import { type Detector, referenceDetector } from "../detector.js";

export const alwaysQuiet: Detector = {
  name: "M2 alwaysQuiet",
  compare: (cases, baseline, candidate, options) => {
    const real = referenceDetector.compare(cases, baseline, candidate, options);
    if (real.verdict === "NOT_COMPARABLE" || real.verdict === "INCONCLUSIVE") return real;
    // THE BUG: nothing is ever a finding.
    return {
      ...real,
      verdict: "NO_DRIFT",
      reason: "nothing to report",
      confirmedMetrics: [],
      suspectedMetrics: [],
    };
  },
  // THE BUG, again, on the watch side: the wealth process is computed and then ignored.
  watchRound: (state, outcomes, config) => {
    const r = referenceDetector.watchRound(state, outcomes, config);
    return { state: { ...r.state, alarmed: false }, alarmed: false };
  },
};
